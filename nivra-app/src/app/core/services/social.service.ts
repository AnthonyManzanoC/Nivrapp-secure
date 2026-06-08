import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  Contact,
  ContactRadarScanResponse,
  DirectorySearchResponse,
  FileResponse,
  FriendRequest,
  Story,
  StoryMediaPreview,
  StoryPayload,
  UserSummary,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { E2EE_UPLOAD_LIMIT_BYTES, MediaOptimizerService } from './media-optimizer.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

const MAX_STORY_MEDIA_BYTES = E2EE_UPLOAD_LIMIT_BYTES;

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

  constructor() {
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
      if (event.type === 'story.created' || event.type === 'story.worldCreated') {
        const story = event.payload as Story;
        if (story?.id) {
          this.applyStoryUpdate(story);
        }
      }
      if (event.type === 'story.viewed' || event.type === 'story.reacted' || event.type === 'story.commented') {
        const payload = event.payload as Story & { storyId?: string };
        if (payload?.id) {
          this.applyStoryUpdate(payload);
        } else if (payload?.storyId) {
          this.stories.update((items) => items.map((story) =>
            story.id === payload.storyId ? { ...story, viewCount: story.viewCount + 1 } : story));
        }
      }
      if (event.type === 'friend.requested' || event.type === 'friend.updated') {
        void this.load();
      }
    });
  }

  async load(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    this.loading.set(true);
    try {
      const accountKey = this.localAccountKey();
      if (accountKey) {
        const cached = await this.history.stories(accountKey).catch(() => []);
        if (cached.length) {
          this.stories.set(this.activeStories(cached));
        }
      }
      const [contacts, requests, feed, world] = await Promise.all([
        firstValueFrom(this.api.get<Contact[]>('/contacts')).catch(() => []),
        firstValueFrom(this.api.get<FriendRequest[]>('/friends/requests')).catch(() => []),
        firstValueFrom(this.api.get<Story[]>('/stories/feed')).catch(() => []),
        firstValueFrom(this.api.get<Story[]>('/stories/world')).catch(() => []),
      ]);
      this.contacts.set(contacts);
      this.friendRequests.set(requests);
      const normalizedFeed = this.activeStories(feed.map((story) => this.normalizeStory(story)));
      const normalizedWorld = this.activeStories(world.map((story) => this.normalizeStory(story)));
      this.stories.set(normalizedFeed);
      this.worldStories.set(normalizedWorld);
      this.persistStories([...normalizedFeed, ...normalizedWorld]);
    } finally {
      this.loading.set(false);
    }
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
          allowedUserIds: allowedUserIds.length ? allowedUserIds : [this.auth.session()?.user.id].filter(Boolean),
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

      const payload = this.encodeStoryPayload({ v: 2, type: media ? 'media' : 'text', text, media });
      const story = await firstValueFrom(this.api.post<Story>('/stories', {
        visibility: options.visibility,
        targetType: options.targetType ?? 'contacts',
        targetId: options.targetId ?? null,
        encryptedPayload: payload,
        caption: text.slice(0, 180) || null,
        mediaFileObjectId,
        allowedUserIds,
        viewOnce: Boolean(options.viewOnce),
        durationSeconds,
      }));
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
    this.activeStory.set(normalized);
    this.applyStoryUpdate(normalized);
    if (this.storyPayload(fresh).media) {
      await this.ensureStoryMedia(fresh).catch(() => null);
    }
  }

  async reactStory(story: Story, emoji: string): Promise<Story> {
    const updated = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/react`, {
      emoji,
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
    const repost = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/repost`, {
      visibility,
      durationSeconds: 24 * 60 * 60,
    }));
    this.applyStoryUpdate(repost);
    await this.load().catch(() => undefined);
    return repost;
  }

  async deleteStory(story: Story): Promise<void> {
    await firstValueFrom(this.api.delete(`/stories/${encodeURIComponent(story.id)}`));
    this.stories.update((items) => items.filter((item) => item.id !== story.id));
    this.worldStories.update((items) => items.filter((item) => item.id !== story.id));
    if (this.activeStory()?.id === story.id) {
      this.activeStory.set(null);
    }
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
    if (!story?.encryptedPayload) {
      return { type: 'text', text: '' };
    }
    try {
      const text = new TextDecoder().decode(this.crypto.ub64(story.encryptedPayload));
      const payload = JSON.parse(text) as StoryPayload;
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
    return this.activeStories(this.stories().filter((story) => this.isGroupStory(story) && story.targetId === groupId));
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

  private encodeStoryPayload(payload: StoryPayload): string {
    return this.crypto.b64(new TextEncoder().encode(JSON.stringify({ v: 2, ...payload, type: payload.type || 'text' })));
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
      myReaction: story.myReaction ?? null,
      originalStoryId: story.originalStoryId ?? null,
      originalAuthor: story.originalAuthor ?? null,
    };
  }

  private applyStoryUpdate(story: Story): Story {
    const normalized = this.normalizeStory(story);
    this.stories.update((items) => [normalized, ...items.filter((item) => item.id !== normalized.id)]
      .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '')));
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
