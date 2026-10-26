import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, eyeOutline, happyOutline, heart, heartOutline, musicalNotesOutline, pauseOutline, playOutline, repeatOutline, sendOutline, volumeHighOutline, volumeMuteOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { Story, StoryPayload } from '../../core/models/nivra.models';
import { SocialService } from '../../core/services/social.service';
export interface StoryPointerUpEvent { event: PointerEvent; side: 'left' | 'right'; }

/** One playback clock shared by all entry points. Actual media time is authoritative. */
@Component({
  selector: 'app-story-viewer', standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, IonIcon, IonInput, IonSpinner],
  templateUrl: './story-viewer.component.html', styleUrls: ['./story-viewer.component.scss'],
})
export class StoryViewerComponent implements OnChanges, OnDestroy {
  readonly social = inject(SocialService);
  private readonly zone = inject(NgZone);
  readonly heartEmoji = '❤️';
  readonly defaultReactionOptions = ['❤️', '😂', '😮', '😢', '👏', '🔥'];
  @Input({ required: true }) story!: Story;
  @Input({ required: true }) payload!: StoryPayload;
  @Input() queue: Story[] = [];
  @Input() progress: number[] = [];
  @Input() reply = '';
  @Input() busyId = '';
  @Input() reactionsOpen = false;
  @Input() isMine = false;
  @Input() uiHidden = false;
  @Input() paused = false;
  @Input() subtitle = '';
  @Input() viewsCount = 0;
  @Input() canRepost = true;
  @Input() reactionOptions: string[] = this.defaultReactionOptions;
  @Output() replyChange = new EventEmitter<string>();
  @Output() closeViewer = new EventEmitter<void>();
  @Output() previous = new EventEmitter<void>();
  @Output() next = new EventEmitter<void>();
  @Output() pointerDown = new EventEmitter<PointerEvent>();
  @Output() pointerUp = new EventEmitter<StoryPointerUpEvent>();
  @Output() pointerCancel = new EventEmitter<void>();
  @Output() syncDuration = new EventEmitter<Event>();
  @Output() mediaEnded = new EventEmitter<void>();
  @Output() openStats = new EventEmitter<void>();
  @Output() sendReply = new EventEmitter<void>();
  @Output() react = new EventEmitter<string>();
  @Output() toggleReactions = new EventEmitter<void>();
  @Output() repost = new EventEmitter<void>();
  localProgress = 0;
  userPaused = false;
  inputFocused = false;
  muted = false;
  needsPlay = false;
  mediaFailed = false;
  mediaReady = false;
  musicReady = false;
  buffering = false;
  captionExpanded = false;
  repostConfirmOpen = false;
  deleteConfirmOpen = false;
  actionError = false;
  actionBusy = false;
  imageRevision = 0;
  private destroyed = false;
  private held = false;
  private textElapsed = 0;
  private lastTick = performance.now();
  private timer: number | null = null;
  private media: HTMLMediaElement | null = null;
  private completed = false;
  private playRevision = 0;
  private readonly visibilityListener = () => this.zone.run(() => this.syncPlayback());
  @ViewChild('storyMedia') set storyMedia(ref: ElementRef<HTMLMediaElement> | undefined) {
    if (this.media && this.media !== ref?.nativeElement) this.media.pause();
    this.media = ref?.nativeElement ?? null;
    if (this.media) { this.media.muted = this.muted; this.syncPlayback(); }
  }
  constructor() {
    addIcons({ closeOutline, eyeOutline, happyOutline, heart, heartOutline, musicalNotesOutline, pauseOutline, playOutline, repeatOutline, sendOutline, volumeHighOutline, volumeMuteOutline });
    document.addEventListener('visibilitychange', this.visibilityListener);
    effect(() => { this.social.storyReadyId(); this.syncPlayback(); });
    this.zone.runOutsideAngular(() => this.timer = window.setInterval(() => this.tick(), 80));
  }
  ngOnChanges(changes: SimpleChanges): void {
    if (changes['story'] && changes['story'].previousValue?.id !== this.story?.id) this.resetPlayback();
    this.syncPlayback();
  }
  ngOnDestroy(): void {
    this.destroyed = true;
    this.playRevision += 1;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.media?.pause();
    this.media = null;
    document.removeEventListener('visibilitychange', this.visibilityListener);
  }
  progressFor(index: number): number {
    return this.queue[index]?.id === this.story.id ? this.localProgress : this.progress[index] ?? 0;
  }
  onReplyChange(value: string | number | null | undefined): void { this.replyChange.emit(String(value ?? '')); }
  focusReply(focused: boolean): void { this.inputFocused = focused; this.syncPlayback(); }
  press(event: PointerEvent): void {
    if (event.button !== 0 || this.held) return;
    this.held = true;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.syncPlayback(); this.pointerDown.emit(event);
  }
  release(event: PointerEvent, side: 'left' | 'right'): void {
    if (!this.held) return;
    this.held = false;
    this.pointerUp.emit({ event, side }); this.syncPlayback();
  }
  cancelPress(): void { this.held = false; this.pointerCancel.emit(); this.syncPlayback(); }
  togglePause(): void { this.userPaused = !this.userPaused; this.syncPlayback(); }
  toggleMute(): void {
    this.muted = !this.muted;
    if (this.media) this.media.muted = this.muted;
    this.needsPlay = false; this.syncPlayback();
  }
  async playFromGesture(): Promise<void> {
    this.userPaused = false; this.needsPlay = false; this.mediaFailed = false;
    if (this.media && (!this.payload?.music || (this.mediaReady && this.musicReady))) {
      const revision = ++this.playRevision;
      const media = this.media;
      try {
        await media.play();
        if (this.destroyed || this.media !== media || this.stopped()) media.pause();
      }
      catch { if (!this.destroyed && revision === this.playRevision) this.needsPlay = true; }
    }
    this.syncPlayback();
  }
  loadedImage(): void { this.mediaReady = true; this.mediaFailed = false; this.lastTick = performance.now(); this.syncPlayback(); }
  loadedMedia(event: Event): void {
    if (this.payload?.music) this.musicReady = true; else this.mediaReady = true;
    this.mediaFailed = false; this.buffering = false;
    // Legacy parents use video metadata for their clocks. A photo with music
    // is timed here by its already-trimmed audio, never by the original song.
    if (!this.payload?.music) this.syncDuration.emit(event);
    this.syncPlayback();
  }
  waitingMedia(): void { this.buffering = true; }
  playingMedia(): void { this.buffering = false; }
  toggleCaption(): void { this.captionExpanded = !this.captionExpanded; this.syncPlayback(); }
  failedMedia(): void { this.mediaFailed = true; this.mediaReady = false; this.buffering = false; this.media?.pause(); }
  ended(): void {
    if (this.stopped()) return;
    this.completed = true; this.localProgress = 100; this.mediaEnded.emit();
  }
  retryMedia(): void {
    this.mediaFailed = false;
    if (!this.payload?.music) this.mediaReady = false; else this.musicReady = false;
    if (this.social.storyReadyId() !== this.story.id) void this.social.viewStory(this.story).catch(() => undefined);
    else if (this.media) { this.media.load(); void this.playFromGesture(); }
    else { this.imageRevision += 1; void this.social.ensureStoryMedia(this.story).catch(() => undefined); }
  }
  showRepost(): void { if (this.isMine || !this.canRepost || this.story.viewOnce) return; this.repostConfirmOpen = true; this.syncPlayback(); }
  showManage(): void { if (!this.isMine) return; this.deleteConfirmOpen = true; this.syncPlayback(); }
  dismissActions(): void { this.repostConfirmOpen = false; this.deleteConfirmOpen = false; this.syncPlayback(); }
  confirmRepost(): void {
    if (!this.repostConfirmOpen || this.isMine || !this.canRepost || this.story.viewOnce) return;
    this.repostConfirmOpen = false; this.repost.emit(); this.syncPlayback();
  }
  async deleteOwnStory(): Promise<void> {
    if (!this.isMine || this.actionBusy) return;
    this.actionBusy = true; this.actionError = false;
    try { await this.social.deleteStory(this.story); this.closeViewer.emit(); }
    catch { if (!this.destroyed) this.actionError = true; }
    finally { this.actionBusy = false; }
  }
  @HostListener('document:keydown', ['$event'])
  onKey(event: KeyboardEvent): void {
    if (this.actionBusy) return;
    if (this.repostConfirmOpen || this.deleteConfirmOpen) {
      if (event.key === 'Escape') { event.preventDefault(); this.dismissActions(); }
      return;
    }
    if (this.inputFocused || /INPUT|TEXTAREA/.test((event.target as HTMLElement)?.tagName || '') || event.isComposing) return;
    if (event.key !== 'Escape' && (event.target as HTMLElement)?.closest?.('button, a, select, [contenteditable="true"]')) return;
    if (event.key === 'Escape') this.closeViewer.emit();
    else if (!this.paused && !this.busyId && event.key === 'ArrowRight') { event.preventDefault(); this.next.emit(); }
    else if (!this.paused && !this.busyId && event.key === 'ArrowLeft') { event.preventDefault(); this.previous.emit(); }
    else if (event.key === ' ') { event.preventDefault(); this.togglePause(); }
  }
  private ready(): boolean { return this.social.storyReadyId() === this.story?.id; }
  private stopped(): boolean {
    return this.destroyed || !this.ready() || document.visibilityState === 'hidden' || this.paused ||
      this.userPaused || this.inputFocused || this.held || this.uiHidden || this.reactionsOpen || Boolean(this.busyId) ||
      this.needsPlay || this.mediaFailed || Boolean(this.social.storyOpenError()) || this.captionExpanded ||
      this.completed || this.repostConfirmOpen || this.deleteConfirmOpen || this.actionBusy;
  }
  private resetPlayback(): void {
    this.playRevision += 1; this.media?.pause(); this.media = null;
    this.localProgress = 0; this.textElapsed = 0; this.completed = false; this.userPaused = false;
    this.held = false; this.inputFocused = false; this.mediaReady = false; this.mediaFailed = false; this.needsPlay = false;
    this.buffering = false; this.captionExpanded = false; this.musicReady = false;
    this.repostConfirmOpen = false; this.deleteConfirmOpen = false; this.actionError = false;
    this.lastTick = performance.now();
  }
  private syncPlayback(): void {
    this.lastTick = performance.now();
    const media = this.media;
    if (!media) return;
    if (this.payload?.music && (!this.mediaReady || !this.musicReady)) { if (!media.paused) media.pause(); return; }
    if (this.stopped()) { if (!media.paused) media.pause(); return; }
    if (!media.paused) return;
    const revision = ++this.playRevision;
    const finishPlay = () => { if (this.destroyed || this.media !== media || this.stopped()) media.pause(); };
    void media.play().then(finishPlay).catch(async () => {
      if (this.destroyed || revision !== this.playRevision || this.media !== media || this.stopped()) return;
      // Autoplay with sound may be blocked. Video can begin silently; its visible
      // sound control lets the user intentionally enable audio.
      if (media instanceof HTMLVideoElement && !media.muted) {
        media.muted = true; this.zone.run(() => this.muted = true);
        try { await media.play(); finishPlay(); return; } catch { /* explicit gesture required */ }
      }
      if (!this.destroyed && revision === this.playRevision) this.zone.run(() => this.needsPlay = true);
    });
  }
  private tick(): void {
    const now = performance.now();
    const delta = Math.max(0, Math.min(250, now - this.lastTick)); this.lastTick = now;
    if (!this.completed && Number.isFinite(Date.parse(this.story?.expiresAt)) && Date.parse(this.story.expiresAt) <= Date.now()) {
      this.completed = true; this.media?.pause(); this.zone.run(() => this.closeViewer.emit()); return;
    }
    if (this.stopped()) { if (this.media && !this.media.paused) this.media.pause(); return; }
    if (this.payload?.media && !this.mediaReady) return;
    if (this.payload?.music && (!this.musicReady || !this.media)) return;
    if (this.media) {
      if (this.media.paused || this.media.seeking || this.media.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const duration = this.payload?.music?.durationSeconds ?? this.media.duration;
      if (Number.isFinite(duration) && duration > 0) {
        this.zone.run(() => this.localProgress = Math.min(100, this.media!.currentTime / duration * 100));
        if (this.payload?.music && this.media.currentTime >= duration) { this.media.pause(); this.zone.run(() => this.ended()); }
      }
      return; // Only a real ended event advances audio/video.
    }
    this.textElapsed += delta;
    const duration = Math.min(12000, Math.max(5000, (this.payload?.text?.length || 0) * 45));
    this.zone.run(() => { this.localProgress = Math.min(100, this.textElapsed / duration * 100); if (this.localProgress >= 100) this.ended(); });
  }
}
