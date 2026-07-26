import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  Contact,
  ContactRadarScanResponse,
  DirectorySearchResponse,
  FileResponse,
  FriendRequest,
  PublicKeyDirectory,
  RecipientCipherRequest,
  Story,
  StoryMediaPreview,
  StoryPayload,
  UserSummary,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService, PublicKeyRecipient } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { E2EE_UPLOAD_LIMIT_BYTES, MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

const MAX_STORY_MEDIA_BYTES = E2EE_UPLOAD_LIMIT_BYTES;

interface EncryptedStoryEnvelope {
  v: 3;
  type: 'nivra-story-e2ee';
  recipients: RecipientCipherRequest[];
}

@Injectable({ providedIn: 'root' })
export class SocialService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly history = inject(LocalHistoryService);
  private readonly mediaOptimizer = inject(MediaOptimizerService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);

  readonly people = signal<UserSummary[]>([]);
  readonly contacts = signal<Contact[]>([]);
  readonly friendRequests = signal<FriendRequest[]>([]);
  readonly stories = signal<Story[]>([]);
  readonly worldStories = signal<Story[]>([]);
  readonly radarMatches = signal<UserSummary[]>([]);
  readonly radarNewCount = signal(0);
  readonly activeStory = signal<Story | null>(null);
  readonly mediaPreviews = signal<Record<string, StoryMediaPreview>>({});
  readonly loading = signal(false);
  readonly radarLoading = signal(false);
  readonly publishing = signal(false);
  readonly publishingStatus = signal('');
  readonly decodedPayloads = signal<Record<string, StoryPayload>>({});
  private loadInFlight: Promise<void> | null = null;
  private storyRealtimeVersion = 0;

  constructor() {
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
      if (event.type === 'story.created' || event.type === 'story.worldCreated') {
        const story = event.payload as Story;
        if (story?.id) {
          this.storyRealtimeVersion += 1;
          this.applyStoryUpdate(story);
        }
      }
      if (event.type === 'story.deleted') {
        const payload = event.payload as { id?: string; storyId?: string };
        const storyId = payload?.storyId || payload?.id;
        if (storyId) {
          this.storyRealtimeVersion += 1;
          this.removeStoryLocally(storyId);
        }
      }
      if (event.type === 'story.viewed' || event.type === 'story.reacted' || event.type === 'story.commented') {
        const payload = event.payload as Story & { storyId?: string };
        if (payload?.id) {
          this.storyRealtimeVersion += 1;
          this.applyStoryUpdate(payload);
        } else if (payload?.storyId) {
          this.storyRealtimeVersion += 1;
          this.stories.update((items) => items.map((story) =>
            story.id === payload.storyId ? { ...story, viewCount: story.viewCount + 1 } : story));
        }
      }
      if (event.type === 'friend.requested' ||
          event.type === 'friend.updated' ||
          event.type === 'conversation.created' ||
          event.type === 'conversation.updated') {
        void this.load();
      }
    });
  }

  async load(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    if (this.loadInFlight) {
      return this.loadInFlight;
    }
    const task = this.loadOnce();
    this.loadInFlight = task;
    try {
      await task;
    } finally {
      if (this.loadInFlight === task) {
        this.loadInFlight = null;
      }
    }
  }

  private async loadOnce(): Promise<void> {
    this.loading.set(true);
    try {
      const accountKey = this.localAccountKey();
      if (accountKey) {
        const cached = await this.history.stories(accountKey).catch(() => []);
        if (cached.length && !this.stories().length) {
          this.stories.set(this.activeStories(cached));
        }
      }
      const realtimeVersionAtRequest = this.storyRealtimeVersion;
      const [contactsResult, requestsResult, feedResult, worldResult] = await Promise.allSettled([
        firstValueFrom(this.api.get<Contact[]>('/contacts')),
        firstValueFrom(this.api.get<FriendRequest[]>('/friends/requests')),
        firstValueFrom(this.api.get<Story[]>('/stories/feed')),
        firstValueFrom(this.api.get<Story[]>('/stories/world')),
      ]);
      if (contactsResult.status === 'fulfilled') {
        this.contacts.set(contactsResult.value);
      }
      if (requestsResult.status === 'fulfilled') {
        this.friendRequests.set(requestsResult.value);
      }

      let persisted: Story[] = [];
      if (feedResult.status === 'fulfilled') {
        const normalizedFeed = this.activeStories(feedResult.value.map((story) => this.normalizeStory(story)));
        const nextFeed = realtimeVersionAtRequest === this.storyRealtimeVersion
          ? normalizedFeed
          : this.mergeStories(normalizedFeed, this.stories());
        this.stories.set(nextFeed);
        persisted = [...persisted, ...nextFeed];
      }
      if (worldResult.status === 'fulfilled') {
        const normalizedWorld = this.activeStories(worldResult.value.map((story) => this.normalizeStory(story)));
        const nextWorld = realtimeVersionAtRequest === this.storyRealtimeVersion
          ? normalizedWorld
          : this.mergeStories(normalizedWorld, this.worldStories());
        this.worldStories.set(nextWorld);
        persisted = [...persisted, ...nextWorld];
      }
      if (persisted.length) {
        this.persistStories(persisted);
      }
    } finally {
      this.loading.set(false);
    }
  }

  async loadGroupStories(groupId: string | null | undefined): Promise<Story[]> {
    const normalizedGroupId = String(groupId || '').trim();
    if (!normalizedGroupId || !this.auth.isAuthenticated()) {
      return [];
    }
    const realtimeVersionAtRequest = this.storyRealtimeVersion;
    const remote = await firstValueFrom(
      this.api.get<Story[]>(`/stories/group/${encodeURIComponent(normalizedGroupId)}`),
    );
    const normalized = this.activeStories(remote.map((story) => this.normalizeStory(story)));
    const current = this.stories();
    const currentGroup = current.filter((story) => this.sameId(story.targetId, normalizedGroupId));
    const nextGroup = realtimeVersionAtRequest === this.storyRealtimeVersion
      ? normalized
      : this.mergeStories(normalized, currentGroup);
    const nextStories = this.activeStories([
      ...current.filter((story) => !this.sameId(story.targetId, normalizedGroupId)),
      ...nextGroup,
    ]);
    this.storyRealtimeVersion += 1;
    this.stories.set(nextStories);
    this.persistStories(nextGroup);
    return nextGroup;
  }

  async search(query: string): Promise<UserSummary[]> {
    const normalized = query.trim();
    if (normalized.length < 2) {
      this.people.set([]);
      return [];
    }
    const response = await firstValueFrom(
      this.api.get<DirectorySearchResponse>(`/directory/search?q=${encodeURIComponent(normalized)}`),
    );
    this.people.set(response.people ?? []);
    return response.people ?? [];
  }

  async scanPhoneRadar(rawPhones: string): Promise<ContactRadarScanResponse> {
    const phones = this.extractPhones(rawPhones);
    if (!phones.length) {
      const empty: ContactRadarScanResponse = {
        submitted: 0,
        matched: 0,
        currentUserInRadar: Boolean(this.auth.session()?.user.phone && this.auth.session()?.user.isDiscoverable),
        people: [],
      };
      this.radarMatches.set([]);
      this.radarNewCount.set(0);
      return empty;
    }

    this.radarLoading.set(true);
    try {
      const phoneHashes = await Promise.all(phones.map((phone) => this.hashPhone(phone)));
      const response = await firstValueFrom(this.api.post<ContactRadarScanResponse>('/contacts/radar/scan', {
        phoneHashes,
      }));
      this.radarMatches.set(response.people ?? []);
      const seen = this.radarSeenIds();
      this.radarNewCount.set((response.people ?? []).filter((person) => !seen.has(person.id)).length);
      this.rememberRadarSeen(response.people ?? []);
      return response;
    } finally {
      this.radarLoading.set(false);
    }
  }

  async requestFriend(person: UserSummary, message = ''): Promise<void> {
    await firstValueFrom(this.api.post('/friends/requests', {
      userId: person.id,
      alias: person.alias,
      message: message || null,
    }));
    await this.load();
  }

  async addContact(person: UserSummary): Promise<void> {
    await firstValueFrom(this.api.post('/contacts', {
      alias: person.alias,
      nicknameCiphertext: null,
    }));
    await this.load();
  }

  async toggleFavorite(contact: Contact): Promise<void> {
    const next = await firstValueFrom(this.api.patch<Contact>(`/contacts/${encodeURIComponent(contact.userId)}`, {
      isFavorite: !contact.isFavorite,
      nicknameCiphertext: null,
    }));
    this.contacts.update((items) => [next, ...items.filter((item) => item.userId !== contact.userId)]
      .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite) || left.alias.localeCompare(right.alias)));
  }

  async deleteContact(contact: Contact): Promise<void> {
    await firstValueFrom(this.api.delete(`/contacts/${encodeURIComponent(contact.userId)}`));
    this.contacts.update((items) => items.filter((item) => item.userId !== contact.userId));
  }

  async accept(requestId: string): Promise<void> {
    await firstValueFrom(this.api.post(`/friends/requests/${encodeURIComponent(requestId)}/accept`, {}));
    await this.load();
  }

  async reject(requestId: string): Promise<void> {
    await firstValueFrom(this.api.post(`/friends/requests/${encodeURIComponent(requestId)}/reject`, {}));
    await this.load();
  }

  async cancel(requestId: string): Promise<void> {
    await firstValueFrom(this.api.post(`/friends/requests/${encodeURIComponent(requestId)}/cancel`, {}));
    await this.load();
  }

  async publishStory(options: {
    text: string;
    visibility: string;
    file?: File | null;
    durationSeconds?: number;
    viewOnce?: boolean;
    allowReposts?: boolean;
    targetType?: 'contacts' | 'group';
    targetId?: string | null;
    allowedUserIds?: string[];
  }): Promise<void> {
    const text = options.text.trim();
    const file = options.file ?? null;
    if (!text && !file) {
      return;
    }

    this.publishing.set(true);
    this.publishingStatus.set(file ? 'Optimizando y sellando (E2EE)...' : '');
    try {
      const durationSeconds = options.durationSeconds ?? 24 * 60 * 60;
      const allowedUserIds = [...new Set((options.allowedUserIds ?? []).filter(Boolean))];
      const contacts = options.visibility === 'MutualContacts'
        ? this.contacts().filter((contact) => contact.isMutualContact)
        : this.contacts();
      const audienceUserIds = [...new Set([
        this.auth.session()?.user.id,
        ...(options.visibility === 'PublicWorld'
          ? []
          : allowedUserIds.length
            ? allowedUserIds
            : contacts.map((contact) => contact.userId)),
      ].filter((userId): userId is string => Boolean(userId)))];
      let mediaFileObjectId: string | null = null;
      let media: StoryPayload['media'] = null;

      if (file) {
        const prepared = await this.mediaOptimizer.prepareForEncryptedUpload(file, {
          mode: 'media',
          maxBytes: MAX_STORY_MEDIA_BYTES,
        });
        const uploadFile = prepared.file;
        const encrypted = await this.crypto.encryptAttachment(await uploadFile.arrayBuffer());
        const mime = uploadFile.type || 'application/octet-stream';
        const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
        const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
          encryptedSize: encrypted.bytes.byteLength,
          mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
          clientSha256: null,
          allowedUserIds: audienceUserIds,
          expiresAt,
        }));
        await firstValueFrom(this.api.putRaw<FileResponse>(`/files/${encodeURIComponent(fileRecord.id)}/blob`, encrypted.bytes));
        mediaFileObjectId = fileRecord.id;
        media = {
          fileId: fileRecord.id,
          fileName: uploadFile.name,
          mime,
          size: uploadFile.size,
          fileKey: encrypted.key,
          fileIv: encrypted.iv,
        };
        this.rememberMediaPreview(`story-file:${fileRecord.id}`, uploadFile, mime, uploadFile.name);
      }

      const decodedPayload: StoryPayload = { v: 2, type: media ? 'media' : 'text', text, media };
      const payload = await this.encodeStoryPayload(decodedPayload, audienceUserIds, options.visibility);
      const story = await firstValueFrom(this.api.post<Story>('/stories', {
        visibility: options.visibility,
        targetType: options.targetType ?? 'contacts',
        targetId: options.targetId ?? null,
        encryptedPayload: payload,
        caption: null,
        mediaFileObjectId,
        allowedUserIds,
        viewOnce: Boolean(options.viewOnce),
        allowReposts: options.allowReposts !== false,
        durationSeconds,
      }));
      this.decodedPayloads.update((items) => ({ ...items, [story.id]: decodedPayload }));
      this.stories.update((items) => [this.normalizeStory(story), ...items.filter((item) => item.id !== story.id)]);
      this.persistStories([story]);
      await this.load();
    } finally {
      this.publishing.set(false);
      this.publishingStatus.set('');
    }
  }

  async publishTextStory(text: string, visibility: string): Promise<void> {
    await this.publishStory({ text, visibility });
  }

  async viewStory(story: Story): Promise<void> {
    const fresh = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/view`, {}));
    const normalized = this.normalizeStory(fresh);
    await this.decodeStoryPayload(normalized);
    this.activeStory.set(normalized);
    this.applyStoryUpdate(normalized);
    if (this.storyPayload(fresh).media) {
      await this.ensureStoryMedia(fresh).catch(() => null);
    }
  }

  async reactStory(story: Story, emoji: string): Promise<Story> {
    const isRemovingCurrentReaction = story.myReaction === emoji;
    const updated = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/react`, {
      emoji: isRemovingCurrentReaction ? story.myReaction : emoji,
    }));
    return this.applyStoryUpdate(updated);
  }

  async commentStory(story: Story, messageId: string | null): Promise<Story> {
    const updated = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/comment`, {
      messageId,
    }));
    return this.applyStoryUpdate(updated);
  }

  async repostStory(story: Story, visibility = 'Contacts'): Promise<Story> {
    const decodedPayload = await this.decodeStoryPayload(story);
    const audienceUserIds = [...new Set([
      this.auth.session()?.user.id,
      ...this.contacts().map((contact) => contact.userId),
    ].filter((userId): userId is string => Boolean(userId)))];
    const encryptedPayload = await this.encodeStoryPayload(decodedPayload, audienceUserIds, visibility);
    const repost = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/repost`, {
      visibility,
      durationSeconds: 24 * 60 * 60,
      encryptedPayload,
      allowReposts: this.auth.session()?.user.allowStoryReposts !== false,
    }));
    this.decodedPayloads.update((items) => ({ ...items, [repost.id]: decodedPayload }));
    this.applyStoryUpdate(repost);
    await this.load().catch(() => undefined);
    return repost;
  }

  async deleteStory(story: Story): Promise<void> {
    await firstValueFrom(this.api.delete(`/stories/${encodeURIComponent(story.id)}`));
    this.storyRealtimeVersion += 1;
    this.removeStoryLocally(story.id);
  }

  async ensureStoryMedia(story: Story): Promise<StoryMediaPreview | null> {
    const payload = this.storyPayload(story);
    if (!payload.media?.fileKey || !payload.media.fileIv) {
      return null;
    }
    const cached = this.mediaPreviews()[story.id];
    if (cached) {
      return cached;
    }
    const encrypted = await firstValueFrom(this.api.getArrayBuffer(`/stories/${encodeURIComponent(story.id)}/media`));
    const plain = await this.crypto.decryptAttachment(encrypted, payload.media.fileKey, payload.media.fileIv);
    return this.rememberMediaPreview(story.id, new Blob([plain], { type: payload.media.mime }), payload.media.mime, payload.media.fileName);
  }

  closeStory(): void {
    this.activeStory.set(null);
  }

  storyPayload(story: Story | null | undefined): StoryPayload {
    const cached = story?.id ? this.decodedPayloads()[story.id] : null;
    if (cached) {
      return cached;
    }
    if (!story?.encryptedPayload) {
      return { type: 'text', text: '' };
    }
    try {
      const text = new TextDecoder().decode(this.crypto.ub64(story.encryptedPayload));
      const payload = JSON.parse(text) as StoryPayload | EncryptedStoryEnvelope;
      if (this.isEncryptedStoryEnvelope(payload)) {
        return { type: 'text', text: story.caption || '' };
      }
      return payload && typeof payload === 'object' ? payload : { type: 'text', text: '' };
    } catch {
      return { type: 'text', text: story.caption || '' };
    }
  }

  storyText(story: Story): string {
    return this.storyPayload(story).text || story.caption || 'Instantanea';
  }

  storyMedia(story: Story | null | undefined): StoryMediaPreview | null {
    return story?.id ? this.mediaPreviews()[story.id] ?? null : null;
  }

  contactStories(): Story[] {
    return this.activeStories(this.stories().filter((story) => !this.isGroupStory(story)));
  }

  groupStories(): Story[] {
    return this.activeStories(this.stories().filter((story) => this.isGroupStory(story)));
  }

  activeStoriesForGroup(groupId: string | null | undefined): Story[] {
    if (!groupId) {
      return [];
    }
    return this.activeStories(this.stories().filter((story) => this.isGroupStory(story) && this.sameId(story.targetId, groupId)));
  }

  isGroupStory(story: Story | null | undefined): boolean {
    return String(story?.targetType || '').toLowerCase() === 'group' || Boolean(story?.targetId);
  }

  isImage(mime = ''): boolean {
    return mime.startsWith('image/');
  }

  isVideo(mime = ''): boolean {
    return mime.startsWith('video/');
  }

  isAudio(mime = ''): boolean {
    return mime.startsWith('audio/');
  }

  private async encodeStoryPayload(payload: StoryPayload, userIds: string[], visibility: string): Promise<string> {
    const normalized = { v: 2, ...payload, type: payload.type || 'text' };
    if (visibility === 'PublicWorld') {
      return this.crypto.b64(new TextEncoder().encode(JSON.stringify(normalized)));
    }

    const current = this.auth.session();
    if (!current) {
      throw new Error('La sesion no esta disponible para cifrar la historia.');
    }
    const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const uniqueUserIds = [...new Set([...userIds, current.user.id].filter(Boolean))];
    const directories = await firstValueFrom(
      this.api.post<PublicKeyDirectory[]>('/keys/batch', { userIds: uniqueUserIds, aliases: [] }),
    ).catch(() => []);
    const recipients: PublicKeyRecipient[] = [];
    for (const directory of directories ?? []) {
      for (const device of directory.devices ?? []) {
        const publicJwk = this.crypto.parsePublicJwk(device.keyBundle?.identityKey);
        if (device.deviceId && publicJwk) {
          recipients.push({ userId: directory.userId, deviceId: device.deviceId, publicJwk });
        }
      }
    }
    if (!recipients.some((recipient) => recipient.userId === current.user.id && recipient.deviceId === current.device.id)) {
      recipients.push({
        userId: current.user.id,
        deviceId: current.device.id,
        publicJwk: own.publicJwk,
      });
    }
    const recipientUserIds = new Set(recipients.map((recipient) => recipient.userId));
    const missingUserIds = uniqueUserIds.filter((userId) => !recipientUserIds.has(userId));
    if (missingUserIds.length) {
      throw new Error('Faltan llaves publicas de uno o mas destinatarios. Sincroniza contactos e intenta de nuevo.');
    }
    const sealed = await this.crypto.encryptGroupPayloadForRecipients(own, recipients, normalized);
    if (!sealed.length) {
      throw new Error('No hay llaves publicas para cifrar la audiencia de la historia.');
    }
    const envelope: EncryptedStoryEnvelope = {
      v: 3,
      type: 'nivra-story-e2ee',
      recipients: sealed,
    };
    return this.crypto.b64(new TextEncoder().encode(JSON.stringify(envelope)));
  }

  private async decodeStoryPayload(story: Story): Promise<StoryPayload> {
    const cached = this.decodedPayloads()[story.id];
    if (cached) {
      return cached;
    }
    const text = new TextDecoder().decode(this.crypto.ub64(story.encryptedPayload));
    const parsed = JSON.parse(text) as StoryPayload | EncryptedStoryEnvelope;
    if (!this.isEncryptedStoryEnvelope(parsed)) {
      const legacy = parsed && typeof parsed === 'object' ? parsed as StoryPayload : { type: 'text', text: '' };
      this.decodedPayloads.update((items) => ({ ...items, [story.id]: legacy }));
      return legacy;
    }

    const current = this.auth.session();
    if (!current) {
      throw new Error('La sesion no esta disponible para descifrar la historia.');
    }
    const recipient = parsed.recipients.find((item) =>
      item.userId === current.user.id && item.deviceId === current.device.id);
    if (!recipient?.ciphertext || !recipient.header) {
      throw new Error('Esta historia no fue cifrada para este dispositivo.');
    }
    const own = await this.crypto.currentKeyMaterial(current.user.alias, current.device.id);
    const payload = await this.crypto.decryptEnvelope<StoryPayload>(own, recipient.header, recipient.ciphertext);
    this.decodedPayloads.update((items) => ({ ...items, [story.id]: payload }));
    return payload;
  }

  private isEncryptedStoryEnvelope(value: unknown): value is EncryptedStoryEnvelope {
    return Boolean(
      value &&
      typeof value === 'object' &&
      (value as { v?: unknown }).v === 3 &&
      (value as { type?: unknown }).type === 'nivra-story-e2ee' &&
      Array.isArray((value as { recipients?: unknown }).recipients),
    );
  }

  private extractPhones(rawPhones: string): string[] {
    const candidates = rawPhones
      .split(/[\n,;]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    return [...new Set(candidates
      .flatMap((value) => this.normalizePhoneCandidates(value)))]
      .slice(0, 512);
  }

  private normalizePhoneCandidates(value: string): string[] {
    const trimmed = String(value || '').trim();
    const hasPlus = trimmed.startsWith('+');
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      return [];
    }
    if (hasPlus) {
      return [`+${digits}`];
    }

    const candidates = [digits];
    if (digits.length >= 11) {
      candidates.push(`+${digits}`);
    }
    const localInternational = this.localInternationalCandidate(digits);
    if (localInternational) {
      candidates.push(localInternational);
    }
    return [...new Set(candidates)];
  }

  private localInternationalCandidate(digits: string): string | null {
    const ownPhone = String(this.auth.session()?.user.phone || '').trim();
    if (!ownPhone.startsWith('+')) {
      return null;
    }
    const ownDigits = ownPhone.replace(/\D/g, '');
    const localDigits = digits.replace(/^0+/, '');
    if (ownDigits.length < 8 || localDigits.length < 7 || localDigits.length > 12) {
      return null;
    }
    const countryCodeLength = ownDigits.length - localDigits.length;
    if (countryCodeLength < 1 || countryCodeLength > 3) {
      return null;
    }
    return `+${ownDigits.slice(0, countryCodeLength)}${localDigits}`;
  }

  private async hashPhone(normalizedPhone: string): Promise<string> {
    return this.crypto.phoneContactHash(normalizedPhone);
  }

  private rememberRadarSeen(people: UserSummary[]): void {
    const accountKey = this.localAccountKey();
    if (!accountKey || !people.length) {
      return;
    }
    try {
      const key = `nivra.radar.seen.${accountKey}`;
      const previous = JSON.parse(localStorage.getItem(key) || '[]') as string[];
      localStorage.setItem(key, JSON.stringify([...new Set([...previous, ...people.map((person) => person.id)])].slice(-500)));
    } catch {
      // Radar memory is local-only and best-effort.
    }
  }

  private radarSeenIds(): Set<string> {
    const accountKey = this.localAccountKey();
    if (!accountKey) {
      return new Set();
    }
    try {
      return new Set(JSON.parse(localStorage.getItem(`nivra.radar.seen.${accountKey}`) || '[]') as string[]);
    } catch {
      return new Set();
    }
  }

  private normalizeStory(story: Story): Story {
    return {
      ...story,
      targetType: story.targetType ?? (story.targetId ? 'group' : 'contacts'),
      targetId: story.targetId ?? null,
      allowedUserIds: story.allowedUserIds ?? [],
      views: story.views ?? [],
      reactions: story.reactions ?? [],
      comments: story.comments ?? [],
      allowReposts: story.allowReposts !== false,
      myReaction: story.myReaction ?? null,
      originalStoryId: story.originalStoryId ?? null,
      originalAuthor: story.originalAuthor ?? null,
    };
  }

  private applyStoryUpdate(story: Story): Story {
    const normalized = this.normalizeStory(story);
    const isOwnPublicStory = normalized.visibility === 'PublicWorld' &&
      normalized.owner.id === this.auth.session()?.user.id;
    this.stories.update((items) => normalized.visibility !== 'PublicWorld' || isOwnPublicStory
      ? [normalized, ...items.filter((item) => item.id !== normalized.id)]
        .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))
      : items.filter((item) => item.id !== normalized.id));
    this.worldStories.update((items) => normalized.visibility === 'PublicWorld'
      ? [normalized, ...items.filter((item) => item.id !== normalized.id)]
        .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''))
      : items.filter((item) => item.id !== normalized.id));
    if (this.activeStory()?.id === normalized.id) {
      this.activeStory.set(normalized);
    }
    this.persistStories([normalized]);
    return normalized;
  }

  private removeStoryLocally(storyId: string): void {
    this.stories.update((items) => items.filter((item) => item.id !== storyId));
    this.worldStories.update((items) => items.filter((item) => item.id !== storyId));
    this.decodedPayloads.update((items) => {
      const next = { ...items };
      delete next[storyId];
      return next;
    });
    const preview = this.mediaPreviews()[storyId];
    if (preview?.url) {
      URL.revokeObjectURL(preview.url);
    }
    this.mediaPreviews.update((items) => {
      const next = { ...items };
      delete next[storyId];
      return next;
    });
    if (this.activeStory()?.id === storyId) {
      this.activeStory.set(null);
    }
    const accountKey = this.localAccountKey();
    if (accountKey) {
      void this.history.removeStory(accountKey, storyId).catch(() => undefined);
    }
  }

  private mergeStories(primary: Story[], secondary: Story[]): Story[] {
    const storiesById = new Map<string, Story>();
    for (const story of [...secondary, ...primary]) {
      if (story?.id) {
        storiesById.set(story.id, this.normalizeStory(story));
      }
    }
    return this.activeStories([...storiesById.values()]);
  }

  private sameId(left: string | null | undefined, right: string | null | undefined): boolean {
    return Boolean(left && right && left.trim().toLowerCase() === right.trim().toLowerCase());
  }

  private activeStories(stories: Story[]): Story[] {
    const now = Date.now();
    return stories
      .map((story) => this.normalizeStory(story))
      .filter((story) => !story.expiresAt || Date.parse(story.expiresAt) > now)
      .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
  }

  private persistStories(stories: Story[]): void {
    const accountKey = this.localAccountKey();
    if (!accountKey || !stories.length) {
      return;
    }
    void this.history.putStories(accountKey, stories.map((story) => this.normalizeStory(story))).catch(() => undefined);
  }

  private localAccountKey(): string | null {
    return this.auth.session()?.user.id ?? null;
  }

  private rememberMediaPreview(cacheKey: string, fileOrBlob: Blob, mime: string, name: string): StoryMediaPreview {
    const existing = this.mediaPreviews()[cacheKey];
    if (existing?.url) {
      URL.revokeObjectURL(existing.url);
    }
    const blob = fileOrBlob instanceof Blob ? fileOrBlob : new Blob([fileOrBlob], { type: mime || 'application/octet-stream' });
    const preview = {
      storyId: cacheKey,
      url: URL.createObjectURL(blob),
      mime: mime || blob.type || 'application/octet-stream',
      name,
    };
    this.mediaPreviews.update((items) => ({ ...items, [cacheKey]: preview }));
    return preview;
  }
}
