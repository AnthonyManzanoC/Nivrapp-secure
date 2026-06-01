import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  Contact,
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
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

const MAX_STORY_MEDIA_BYTES = 50 * 1024 * 1024;

@Injectable({ providedIn: 'root' })
export class SocialService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);

  readonly people = signal<UserSummary[]>([]);
  readonly contacts = signal<Contact[]>([]);
  readonly friendRequests = signal<FriendRequest[]>([]);
  readonly stories = signal<Story[]>([]);
  readonly worldStories = signal<Story[]>([]);
  readonly activeStory = signal<Story | null>(null);
  readonly mediaPreviews = signal<Record<string, StoryMediaPreview>>({});
  readonly loading = signal(false);
  readonly publishing = signal(false);

  constructor() {
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
      if (event.type === 'story.created' || event.type === 'story.worldCreated') {
        const story = event.payload as Story;
        if (story?.id) {
          this.stories.update((items) => [story, ...items.filter((item) => item.id !== story.id)]);
          if (story.visibility === 'PublicWorld') {
            this.worldStories.update((items) => [story, ...items.filter((item) => item.id !== story.id)]);
          }
        }
      }
      if (event.type === 'story.viewed') {
        const payload = event.payload as { storyId?: string };
        if (payload?.storyId) {
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
      const [contacts, requests, feed, world] = await Promise.all([
        firstValueFrom(this.api.get<Contact[]>('/contacts')).catch(() => []),
        firstValueFrom(this.api.get<FriendRequest[]>('/friends/requests')).catch(() => []),
        firstValueFrom(this.api.get<Story[]>('/stories/feed')).catch(() => []),
        firstValueFrom(this.api.get<Story[]>('/stories/world')).catch(() => []),
      ]);
      this.contacts.set(contacts);
      this.friendRequests.set(requests);
      this.stories.set(feed);
      this.worldStories.set(world);
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
  }): Promise<void> {
    const text = options.text.trim();
    const file = options.file ?? null;
    if (!text && !file) {
      return;
    }
    if (file && file.size > MAX_STORY_MEDIA_BYTES) {
      throw new Error('Maximo 50 MB por historia cifrada.');
    }

    this.publishing.set(true);
    try {
      const durationSeconds = options.durationSeconds ?? 24 * 60 * 60;
      let mediaFileObjectId: string | null = null;
      let media: StoryPayload['media'] = null;

      if (file) {
        const encrypted = await this.crypto.encryptAttachment(await file.arrayBuffer());
        const mime = file.type || 'application/octet-stream';
        const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
        const fileRecord = await firstValueFrom(this.api.post<FileResponse>('/files', {
          encryptedSize: encrypted.bytes.byteLength,
          mimeTypeCiphertext: this.crypto.b64(new TextEncoder().encode(mime)),
          clientSha256: null,
          allowedUserIds: [this.auth.session()?.user.id].filter(Boolean),
          expiresAt,
        }));
        await firstValueFrom(this.api.putRaw<FileResponse>(`/files/${encodeURIComponent(fileRecord.id)}/blob`, encrypted.bytes));
        mediaFileObjectId = fileRecord.id;
        media = {
          fileId: fileRecord.id,
          fileName: file.name,
          mime,
          size: file.size,
          fileKey: encrypted.key,
          fileIv: encrypted.iv,
        };
        this.rememberMediaPreview(`story-file:${fileRecord.id}`, file, mime, file.name);
      }

      const payload = this.encodeStoryPayload({ v: 2, type: media ? 'media' : 'text', text, media });
      await firstValueFrom(this.api.post<Story>('/stories', {
        visibility: options.visibility,
        encryptedPayload: payload,
        caption: text.slice(0, 180) || null,
        mediaFileObjectId,
        allowedUserIds: [],
        viewOnce: Boolean(options.viewOnce),
        durationSeconds,
      }));
      await this.load();
    } finally {
      this.publishing.set(false);
    }
  }

  async publishTextStory(text: string, visibility: string): Promise<void> {
    await this.publishStory({ text, visibility });
  }

  async viewStory(story: Story): Promise<void> {
    const fresh = await firstValueFrom(this.api.post<Story>(`/stories/${encodeURIComponent(story.id)}/view`, {}));
    this.activeStory.set(fresh);
    this.stories.update((items) => [fresh, ...items.filter((item) => item.id !== fresh.id)]);
    if (this.storyPayload(fresh).media) {
      await this.ensureStoryMedia(fresh).catch(() => null);
    }
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
