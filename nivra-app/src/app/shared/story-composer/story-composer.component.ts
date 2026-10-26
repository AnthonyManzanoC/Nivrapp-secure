import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonModal, IonSpinner } from '@ionic/angular/standalone';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { addIcons } from 'ionicons';
import { cameraOutline, checkmarkOutline, closeOutline, expandOutline, imageOutline, musicalNotesOutline, pauseOutline, playOutline, refreshOutline, sendOutline, settingsOutline, shieldCheckmarkOutline, textOutline, videocamOutline, volumeHighOutline, volumeMuteOutline } from 'ionicons/icons';
import { Conversation } from '../../core/models/nivra.models';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { E2EE_UPLOAD_LIMIT_BYTES } from '../../core/services/media-optimizer.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { MediaStreamDirective } from '../media-stream.directive';
import { encodeStoryMusicFragment, STORY_MUSIC_SOURCE_MAX_BYTES, STORY_MUSIC_SOURCE_MAX_SECONDS, validMusicWindow } from '../../core/services/story-music';

type ComposerMode = 'choose' | 'edit' | 'camera';
type MediaKind = 'image' | 'video' | 'audio' | '';

/** The shared draft stays in memory. Media still goes through SocialService's E2EE upload. */
@Component({
  selector: 'app-story-composer',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, MediaStreamDirective, IonModal, IonIcon, IonSpinner],
  templateUrl: './story-composer.component.html',
  styleUrls: ['./story-composer.component.scss'],
})
export class StoryComposerComponent implements OnChanges, OnDestroy {
  readonly social = inject(SocialService);
  readonly auth = inject(AuthService);
  readonly chat = inject(ChatService);
  private readonly translate = inject(TranslateService);
  private readonly zone = inject(NgZone);
  @Input() isOpen = false;
  @Output() closed = new EventEmitter<void>();
  @Output() published = new EventEmitter<string>();
  @ViewChild('cameraPreview') private cameraPreview?: ElementRef<HTMLVideoElement>;
  @ViewChild('captionInput') private captionInput?: ElementRef<HTMLTextAreaElement>;
  @ViewChild('draftMedia') private draftMedia?: ElementRef<HTMLMediaElement>;
  @ViewChild('draftMusic') private draftMusic?: ElementRef<HTMLAudioElement>;
  @ViewChild('draftPreview') set draftPreview(ref: ElementRef<HTMLElement> | undefined) {
    const revision = ++this.previewRevision;
    this.previewObserver?.disconnect();
    this.previewObserver = null;
    if (!ref) return;
    const measure = () => {
      if (revision !== this.previewRevision) return;
      const { width, height } = ref.nativeElement.getBoundingClientRect();
      if (width && height) this.previewAspect = width / height;
    };
    // A ViewChild setter runs during view checking. Measure after that turn so
    // the preview style stays stable through Angular's verification pass.
    queueMicrotask(() => this.zone.run(measure));
    this.previewObserver = new ResizeObserver(() => this.zone.run(measure));
    this.previewObserver.observe(ref.nativeElement);
  }

  mode: ComposerMode = 'choose';
  file: File | null = null;
  previewUrl = '';
  mediaKind: MediaKind = '';
  text = '';
  audience = 'contacts';
  visibility = 'Contacts';
  durationSeconds = 86400;
  viewOnce = false;
  allowReposts = true;
  settingsOpen = false;
  imageRotation = 0;
  imageCrop = false;
  imageWidth = 0;
  imageHeight = 0;
  imageLoading = false;
  cameraStream: MediaStream | null = null;
  cameraBusy = false;
  facing: 'user' | 'environment' = 'environment';
  recording = false;
  recordingSeconds = 0;
  busy = false;
  error = '';
  publicationFailed = false;
  confirmingDiscard = false;
  musicUrl = '';
  musicTitle = '';
  musicTotal = 0;
  musicStart = 0;
  musicLength = 15;
  musicLoading = false;
  musicPlaying = false;
  musicMuted = false;
  musicError = '';
  private musicBuffer: AudioBuffer | null = null;
  private musicContext: AudioContext | null = null;
  private musicRevision = 0;
  private musicStopTimer: number | null = null;
  private composerAccount = '';
  readonly native = Capacitor.isNativePlatform();
  readonly recordingSupported = typeof MediaRecorder !== 'undefined';
  private generation = 0;
  private previewAspect = 9 / 16;
  private previewObserver: ResizeObserver | null = null;
  private previewRevision = 0;
  private closedEmitted = false;
  private dismissRequested = false;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private recordingBytes = 0;
  private recordingTimer: number | null = null;
  private captionFocusTimer: number | null = null;
  private recordingStartedAt = 0;
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.draftMedia?.nativeElement.pause();
    if (document.visibilityState === 'hidden') this.pauseMusic();
    if (document.visibilityState !== 'hidden' || !this.cameraStream) return;
    // Leaving the app must never leave a camera or microphone recording invisibly.
    this.zone.run(() => this.recording ? this.finishRecording() : this.leaveCamera());
  };

  readonly canDismiss = () => this.dismissRequested || (!this.busy && !this.hasDraft() && !this.cameraBusy);

  constructor() {
    addIcons({ cameraOutline, checkmarkOutline, closeOutline, expandOutline, imageOutline, musicalNotesOutline, pauseOutline, playOutline, refreshOutline, sendOutline, settingsOutline, shieldCheckmarkOutline, textOutline, videocamOutline, volumeHighOutline, volumeMuteOutline });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    const initial = this.auth.session();
    this.composerAccount = initial ? `${initial.user.id}:${initial.device.id}:${this.auth.sessionGeneration?.() ?? 0}` : '';
    effect(() => {
      const session = this.auth.session();
      const activation = this.auth.sessionGeneration?.() ?? 0;
      const scope = session ? `${session.user.id}:${session.device.id}:${activation}` : '';
      untracked(() => {
        if (this.composerAccount && scope !== this.composerAccount) this.finishClose();
        this.composerAccount = scope;
      });
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['isOpen']) return;
    if (this.isOpen) {
      this.resetDraft();
      this.closedEmitted = false;
      this.dismissRequested = false;
      this.allowReposts = this.auth.session()?.user.allowStoryReposts !== false;
    } else {
      this.resetDraft();
    }
  }

  ngOnDestroy(): void {
    ++this.previewRevision;
    this.previewObserver?.disconnect();
    this.resetDraft();
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen) this.requestClose();
  }

  hasDraft(): boolean {
    return Boolean(this.file || this.text.trim() || this.recording);
  }

  requestClose(): void {
    if (this.busy) return;
    if (this.hasDraft()) {
      if (this.recording) this.finishRecording();
      this.confirmingDiscard = true;
    } else {
      this.finishClose();
    }
  }

  discardAndClose(): void {
    if (!this.busy) this.finishClose();
  }

  onDismissed(): void {
    this.finishClose();
  }

  private finishClose(): void {
    this.dismissRequested = true;
    this.resetDraft();
    if (!this.closedEmitted) {
      this.closedEmitted = true;
      this.closed.emit();
    }
  }

  chooseText(): void {
    this.error = '';
    this.publicationFailed = false;
    this.mode = 'edit';
    this.focusCaption();
  }

  private focusCaption(): void {
    if (this.captionFocusTimer !== null) window.clearTimeout(this.captionFocusTimer);
    this.captionFocusTimer = window.setTimeout(() => {
      this.captionFocusTimer = null;
      this.captionInput?.nativeElement.focus();
    }, 100);
  }

  fileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (file) this.selectFile(file);
  }

  selectFile(file: File): boolean {
    if (this.busy) return false;
    const kind = file.type.split('/')[0] as MediaKind;
    if (!['image', 'video', 'audio'].includes(kind)) {
      this.error = this.tr('STORY_COMPOSER.UNSUPPORTED_FILE', 'Elige una foto, un video o un audio.');
      return false;
    }
    if (!file.size || file.size > E2EE_UPLOAD_LIMIT_BYTES) {
      this.error = this.tr('STORY_COMPOSER.FILE_SIZE_ERROR', 'Este archivo está vacío o supera el límite de 256 MB. Elige otro.');
      return false;
    }
    this.releaseCapture();
    this.releasePreview();
    this.removeMusic();
    this.file = file;
    this.mediaKind = kind;
    this.previewUrl = URL.createObjectURL(file);
    this.imageRotation = 0;
    this.imageCrop = false;
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.imageLoading = kind === 'image';
    this.error = '';
    this.publicationFailed = false;
    this.mode = 'edit';
    return true;
  }

  removeFile(): void {
    if (this.busy) return;
    this.releasePreview();
    this.removeMusic();
    this.file = null;
    this.mediaKind = '';
    this.imageLoading = false;
    this.imageRotation = 0;
    this.imageCrop = false;
    this.imageWidth = 0;
    this.imageHeight = 0;
  }

  async musicSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0]; input.value = '';
    if (file) await this.selectMusic(file);
  }

  async selectMusic(file: File): Promise<void> {
    if (this.busy || this.mediaKind !== 'image') return;
    if (!file.type.startsWith('audio/') || !file.size || file.size > STORY_MUSIC_SOURCE_MAX_BYTES) {
      this.musicError = 'Elige un audio mono o estéreo de hasta 12 MB y 5 minutos.'; return;
    }
    const revision = ++this.musicRevision;
    const generation = this.generation;
    const session = this.auth.session();
    const activation = this.auth.sessionGeneration?.();
    const scope = session ? `${session.user.id}:${session.device.id}` : '';
    const current = () => revision === this.musicRevision && generation === this.generation && this.isOpen && this.mediaKind === 'image'
      && `${this.auth.session()?.user.id}:${this.auth.session()?.device.id}` === scope;
    const currentActivation = () => current() && activation === this.auth.sessionGeneration?.();
    this.musicLoading = true; this.musicError = ''; this.pauseMusic();
    const previousContext = this.musicContext; this.musicContext = null;
    if (previousContext) await previousContext.close().catch(() => undefined);
    if (!currentActivation()) return;
    const url = URL.createObjectURL(file);
    let retained = false;
    let context: AudioContext | null = null;
    try {
      // Probe duration before PCM decoding: compressed long recordings can
      // otherwise allocate hundreds of megabytes on a mobile WebView.
      await this.probeMusic(url);
      if (!currentActivation()) return;
      context = new AudioContext({ sampleRate: 22050 }); this.musicContext = context;
      const buffer = await this.withMusicDeadline(context.decodeAudioData(await file.arrayBuffer()));
      if (!currentActivation()) return;
      if (!Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.duration > STORY_MUSIC_SOURCE_MAX_SECONDS || buffer.numberOfChannels > 2)
        throw new Error('Elige un audio mono o estéreo de hasta 5 minutos.');
      this.clearMusicAsset();
      this.musicBuffer = buffer; this.musicUrl = url; retained = true;
      this.musicTitle = file.name.replace(/\.[^.]+$/, '').slice(0, 80);
      this.musicTotal = buffer.duration; this.musicStart = 0; this.musicLength = Math.min(15, buffer.duration);
    } catch (error) {
      if (currentActivation()) this.musicError = error instanceof Error && /hasta 5 minutos/.test(error.message) ? error.message : 'No se pudo abrir este audio. Prueba con MP3, M4A, OGG o WAV compatible.';
    } finally {
      if (!retained) URL.revokeObjectURL(url);
      if (context) await context.close().catch(() => undefined);
      if (this.musicContext === context) this.musicContext = null;
      if (revision === this.musicRevision) this.musicLoading = false;
    }
  }

  private probeMusic(url: string): Promise<void> {
    const audio = new Audio(); audio.preload = 'metadata';
    return this.withMusicDeadline(new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => Number.isFinite(audio.duration) && audio.duration > 0 && audio.duration <= STORY_MUSIC_SOURCE_MAX_SECONDS
        ? resolve() : reject(new Error('Elige un audio mono o estéreo de hasta 5 minutos.'));
      audio.onerror = () => reject(new Error('audio-format')); audio.src = url;
    })).finally(() => { audio.onloadedmetadata = null; audio.onerror = null; audio.pause(); audio.removeAttribute('src'); audio.load(); });
  }

  private withMusicDeadline<T>(operation: Promise<T>): Promise<T> {
    let timer: number;
    return Promise.race([operation, new Promise<T>((_resolve, reject) => timer = window.setTimeout(() => reject(new Error('audio-timeout')), 15000))])
      .finally(() => window.clearTimeout(timer));
  }

  updateMusicWindow(start: number | string = this.musicStart, duration: number | string = this.musicLength): void {
    this.pauseMusic();
    this.musicLength = Math.min(15, this.musicTotal, Math.max(Math.min(.25, this.musicTotal), Number(duration) || 0));
    this.musicStart = Math.max(0, Math.min(Number(start) || 0, this.musicTotal - this.musicLength));
    if (this.draftMusic) this.draftMusic.nativeElement.currentTime = this.musicStart;
  }
  async toggleMusicPreview(): Promise<void> {
    const audio = this.draftMusic?.nativeElement;
    if (!audio || !this.musicBuffer || this.musicLoading) return;
    if (this.musicPlaying) { this.pauseMusic(); return; }
    const revision = this.musicRevision;
    audio.currentTime = this.musicStart; audio.muted = this.musicMuted;
    try {
      await audio.play();
      if (revision !== this.musicRevision || document.visibilityState === 'hidden' || !this.isOpen || this.busy) { audio.pause(); return; }
      this.musicPlaying = true;
      this.watchMusicPreview(audio, revision, Date.now() + Math.max(30000, this.musicLength * 4000));
    } catch { this.musicError = 'Toca reproducir para escuchar el fragmento.'; }
  }
  private watchMusicPreview(audio: HTMLAudioElement, revision: number, deadline: number): void {
    this.musicStopTimer = window.setTimeout(() => {
      if (revision !== this.musicRevision || audio !== this.draftMusic?.nativeElement || !this.musicPlaying) return;
      if (!this.isOpen || this.busy || document.visibilityState === 'hidden' || audio.currentTime >= this.musicStart + this.musicLength) {
        this.pauseMusic(); return;
      }
      // Buffering and a slow play() startup do not consume the selected audio.
      // A bounded watchdog still releases a source that remains stuck forever.
      if (Date.now() >= deadline) {
        this.pauseMusic(); this.musicError = 'El audio dejó de avanzar. Toca reproducir para volver a escuchar el fragmento.'; return;
      }
      this.watchMusicPreview(audio, revision, deadline);
    }, 250);
  }
  musicTimeChanged(): void {
    if ((this.draftMusic?.nativeElement.currentTime ?? 0) >= this.musicStart + this.musicLength) this.pauseMusic();
  }
  toggleMusicMute(): void { this.musicMuted = !this.musicMuted; if (this.draftMusic) this.draftMusic.nativeElement.muted = this.musicMuted; }
  pauseMusic(): void {
    this.draftMusic?.nativeElement.pause(); this.musicPlaying = false;
    if (this.musicStopTimer !== null) window.clearTimeout(this.musicStopTimer);
    this.musicStopTimer = null;
  }
  removeMusic(): void {
    ++this.musicRevision; this.clearMusicAsset(); this.musicLoading = false; this.musicError = '';
    void this.musicContext?.close().catch(() => undefined); this.musicContext = null;
  }
  private clearMusicAsset(): void {
    this.pauseMusic(); this.musicBuffer = null;
    if (this.musicUrl) URL.revokeObjectURL(this.musicUrl);
    this.musicUrl = ''; this.musicTitle = ''; this.musicTotal = 0; this.musicStart = 0; this.musicLength = 15;
  }
  musicTime(seconds: number): string { const value = Math.max(0, Math.floor(seconds)); return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`; }

  imageLoaded(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.imageWidth = image.naturalWidth;
    this.imageHeight = image.naturalHeight;
    this.imageLoading = false;
    if (!this.imageWidth || !this.imageHeight) this.previewFailed();
  }

  previewFailed(): void {
    this.imageLoading = false;
    this.error = this.tr('STORY_COMPOSER.PREVIEW_ERROR', 'No se pudo mostrar este archivo. Prueba con otro formato.');
  }

  rotateImage(): void {
    if (!this.busy) this.imageRotation = (this.imageRotation + 90) % 360;
  }

  /** Match the editor to the encoded image, including odd quarter turns. */
  imagePreviewTransform(): string {
    const oddTurn = this.imageRotation % 180 !== 0;
    const width = oddTurn ? this.imageHeight : this.imageWidth;
    const height = oddTurn ? this.imageWidth : this.imageHeight;
    if (!width || !height) return '';
    const targetAspect = this.previewAspect;
    const sourceAspect = width / height;
    let fittedWidth = sourceAspect >= targetAspect ? 100 : sourceAspect / targetAspect * 100;
    let fittedHeight = sourceAspect >= targetAspect ? targetAspect / sourceAspect * 100 : 100;
    if (this.imageCrop) {
      const scale = Math.max(100 / fittedWidth, 100 / fittedHeight);
      fittedWidth *= scale;
      fittedHeight *= scale;
    }
    return `width: ${oddTurn ? fittedHeight * targetAspect : fittedWidth}%; height: ${oddTurn ? fittedWidth / targetAspect : fittedHeight}%; transform: translate(-50%, -50%) rotate(${this.imageRotation}deg)`;
  }

  groups(): Conversation[] {
    const userId = this.auth.session()?.user.id;
    return this.chat.conversations()
      .filter((group) => this.chat.isGroup(group) && group.participants.some((member) => member.userId === userId && !member.removedAt))
      .sort((left, right) => this.chat.conversationTitle(left).localeCompare(this.chat.conversationTitle(right)));
  }

  audienceLabel(): string {
    if (this.audience !== 'contacts') {
      const group = this.groups().find((item) => item.id === this.audience);
      return group ? this.chat.conversationTitle(group) : this.tr('STORY_COMPOSER.GROUP_UNAVAILABLE', 'Grupo no disponible');
    }
    if (this.visibility === 'PublicWorld') return this.tr('WORLD.WORLD', 'Mundo');
    if (this.visibility === 'MutualContacts') return this.tr('WORLD.MUTUALS', 'Mutuos');
    return this.tr('WORLD.MY_CONTACTS', 'Mis contactos');
  }

  async openCamera(): Promise<void> {
    if (this.busy || this.cameraBusy || this.recording) return;
    this.mode = 'camera';
    this.pauseMusic();
    this.error = '';
    await this.startCamera();
  }

  async switchCamera(): Promise<void> {
    if (this.cameraBusy || this.recording) return;
    this.facing = this.facing === 'environment' ? 'user' : 'environment';
    await this.startCamera();
  }

  private async startCamera(): Promise<void> {
    this.releaseCapture();
    const generation = this.generation;
    this.cameraBusy = true;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('camera-unavailable');
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: this.facing }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
      });
      if (!this.isOpen || this.mode !== 'camera' || generation !== this.generation || document.visibilityState === 'hidden') {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.cameraStream = stream;
    } catch (error) {
      if (generation === this.generation) {
        this.error = this.cameraError(error);
      }
    } finally {
      if (generation === this.generation) this.cameraBusy = false;
    }
  }

  leaveCamera(): void {
    if (this.recording) {
      this.finishRecording();
      return;
    }
    this.releaseCapture();
    this.mode = this.file || this.text.trim() ? 'edit' : 'choose';
  }

  async takePhoto(): Promise<void> {
    const video = this.cameraPreview?.nativeElement;
    if (this.busy || this.cameraBusy || this.recording || !video?.videoWidth || !this.cameraStream) return;
    this.cameraBusy = true;
    const generation = this.generation;
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1920 / Math.max(video.videoWidth, video.videoHeight));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas-unavailable');
      // Selfie preview is mirrored for framing; the actual photo keeps its natural orientation.
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await this.canvasBlob(canvas);
      if (generation === this.generation && this.isOpen) {
        this.selectFile(new File([blob], `nivra-story-${Date.now()}.jpg`, { type: 'image/jpeg' }));
      }
    } catch {
      if (generation === this.generation) this.error = this.tr('STORY_COMPOSER.PHOTO_ERROR', 'No se pudo tomar la foto. Inténtalo otra vez.');
    } finally {
      if (generation === this.generation) this.cameraBusy = false;
    }
  }

  async startRecording(): Promise<void> {
    if (!this.cameraStream || this.recording || this.cameraBusy || !this.recordingSupported) return;
    const stream = this.cameraStream;
    const generation = this.generation;
    this.cameraBusy = true;
    this.error = '';
    try {
      // Microphone is requested only after an explicit tap on Record.
      const audio = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      if (generation !== this.generation || !this.isOpen || stream !== this.cameraStream || document.visibilityState === 'hidden') {
        audio.getTracks().forEach((track) => track.stop());
        return;
      }
      audio.getAudioTracks().forEach((track) => stream.addTrack(track));
      const mime = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_500_000 } : undefined);
      this.recorder = recorder;
      this.recordingChunks = [];
      this.recordingBytes = 0;
      this.recordingSeconds = 0;
      recorder.ondataavailable = (event) => {
        if (generation !== this.generation || !event.data.size) return;
        this.recordingChunks.push(event.data);
        this.recordingBytes += event.data.size;
        if (this.recordingBytes >= 96 * 1024 * 1024) this.zone.run(() => this.finishRecording());
      };
      recorder.onstop = () => {
        if (generation !== this.generation) return;
        this.zone.run(() => {
          const blob = new Blob(this.recordingChunks, { type: recorder.mimeType || mime || 'video/webm' });
          this.recordingChunks = [];
          this.recorder = null;
          this.recording = false;
          this.stopRecordingTimer();
          if (blob.size) {
            this.selectFile(new File([blob], `nivra-story-${Date.now()}.${blob.type.includes('mp4') ? 'mp4' : 'webm'}`, { type: blob.type }));
          } else {
            this.error = this.tr('STORY_COMPOSER.RECORD_ERROR', 'No se pudo guardar el video. Inténtalo otra vez.');
            this.releaseCapture();
          }
        });
      };
      recorder.onerror = () => {
        if (generation !== this.generation) return;
        this.zone.run(() => {
          this.releaseCapture();
          this.error = this.tr('STORY_COMPOSER.RECORD_ERROR', 'No se pudo guardar el video. Inténtalo otra vez.');
        });
      };
      recorder.start(1000);
      this.recording = true;
      this.recordingStartedAt = Date.now();
      this.recordingTimer = window.setInterval(() => this.zone.run(() => {
        this.recordingSeconds = Math.floor((Date.now() - this.recordingStartedAt) / 1000);
        if (this.recordingSeconds >= 60) this.finishRecording();
      }), 250);
    } catch (error) {
      stream.getAudioTracks().forEach((track) => { stream.removeTrack(track); track.stop(); });
      if (generation === this.generation) this.error = this.cameraError(error);
    } finally {
      if (generation === this.generation) this.cameraBusy = false;
    }
  }

  finishRecording(): void {
    this.stopRecordingTimer();
    const recorder = this.recorder;
    if (recorder?.state === 'recording') recorder.stop();
    // A final dataavailable/stop event still creates the preview, but capture ends immediately.
    this.cameraStream?.getTracks().forEach((track) => track.stop());
  }

  async takeNativePhoto(): Promise<void> {
    if (this.busy || this.cameraBusy || this.recording || !this.native) return;
    this.releaseCapture();
    const generation = this.generation;
    this.cameraBusy = true;
    try {
      const photo = await Camera.getPhoto({ quality: 88, allowEditing: false, saveToGallery: false, resultType: CameraResultType.Uri, source: CameraSource.Camera });
      if (!photo.webPath || generation !== this.generation || !this.isOpen) return;
      const response = await fetch(photo.webPath);
      const blob = await response.blob();
      if (generation === this.generation && this.isOpen) {
        const mime = blob.type || `image/${photo.format === 'jpg' ? 'jpeg' : photo.format}`;
        this.selectFile(new File([blob], `nivra-story-${Date.now()}.${photo.format || 'jpg'}`, { type: mime }));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (generation === this.generation && !/cancel/i.test(message)) this.error = this.cameraError(error);
    } finally {
      if (generation === this.generation) this.cameraBusy = false;
    }
  }

  async publish(): Promise<void> {
    if (this.busy || this.social.publishing() || !this.hasDraft() || this.mode === 'camera' || this.imageLoading || this.musicLoading) return;
    if (this.musicBuffer && !validMusicWindow(this.musicTotal, this.musicStart, this.musicLength)) {
      this.musicError = 'Elige un fragmento válido de hasta 15 segundos.'; return;
    }
    const publisher = this.auth.session();
    const userId = publisher?.user.id;
    const deviceId = publisher?.device.id;
    if (!userId || !deviceId) return;
    const generation = this.generation;
    // A deleted group or lost membership must not silently publish to contacts instead.
    let group = this.audience === 'contacts' ? null : this.groups().find((item) => item.id === this.audience);
    if (this.audience !== 'contacts' && !group) {
      this.error = this.tr('STORY_COMPOSER.GROUP_UNAVAILABLE', 'Grupo no disponible');
      return;
    }
    this.busy = true;
    this.error = '';
    this.publicationFailed = false;
    this.draftMedia?.nativeElement.pause();
    this.pauseMusic();
    try {
      const file = await this.editedImageFile();
      if (!this.publicationStillCurrent(userId, deviceId, generation)) return;
      group = this.audience === 'contacts' ? null : this.groups().find((item) => item.id === this.audience);
      if (this.audience !== 'contacts' && !group) {
        this.error = this.tr('STORY_COMPOSER.GROUP_UNAVAILABLE', 'Grupo no disponible');
        return;
      }
      await this.social.publishStory({
        text: this.text.trim(), file,
        ...(this.musicBuffer && validMusicWindow(this.musicTotal, this.musicStart, this.musicLength) ? { music: {
          file: encodeStoryMusicFragment(this.musicBuffer, this.musicStart, this.musicLength), title: this.musicTitle.trim(),
          durationSeconds: Math.floor(this.musicLength * 22050) / 22050, sourceStartSeconds: this.musicStart,
        } } : {}),
        visibility: group ? 'SelectedUsers' : this.visibility,
        durationSeconds: Number(this.durationSeconds), viewOnce: this.viewOnce, allowReposts: !this.viewOnce && this.allowReposts,
        targetType: group ? 'group' : 'contacts', targetId: group?.id ?? null,
        allowedUserIds: group?.participants.filter((member) => !member.removedAt).map((member) => member.userId) ?? [],
      });
      if (!this.publicationStillCurrent(userId, deviceId, generation)) return;
      this.published.emit(this.social.storyDeliveryWarning() || this.tr('WORLD.NOTICE_STORY_PUBLISHED', 'Historia publicada.'));
      this.finishClose();
    } catch (error) {
      if (this.publicationStillCurrent(userId, deviceId, generation)) {
        this.publicationFailed = true;
        this.error = this.tr('STORY_COMPOSER.PUBLISH_ERROR', 'No se pudo publicar. Conservamos tu historia para que puedas intentarlo otra vez.');
        const safeErrors = new Map<string, string>([
          ['La sesion no esta disponible para cifrar la historia.', this.tr('STORY_COMPOSER.SESSION_ERROR', 'Tu sesión cambió. Vuelve a iniciar sesión e inténtalo otra vez.')],
          ['Ningun destinatario tiene un dispositivo cifrado activo. Pideles abrir Nivra e intenta de nuevo.', this.tr('STORY_COMPOSER.RECIPIENT_KEYS_ERROR', 'Ningún destinatario tiene un dispositivo cifrado activo. Pídeles abrir Nivra e inténtalo de nuevo.')],
          ['No se pudo sincronizar el cifrado de la audiencia. Revisa la conexion e intenta de nuevo.', this.tr('STORY_COMPOSER.KEY_SYNC_ERROR', 'No se pudo sincronizar el cifrado de la audiencia. Revisa la conexión e inténtalo de nuevo.')],
          ['No hay llaves publicas para cifrar la audiencia de la historia.', this.tr('STORY_COMPOSER.KEYS_UNAVAILABLE_ERROR', 'No hay llaves públicas disponibles para cifrar esta audiencia. Revisa los dispositivos e inténtalo de nuevo.')],
          ['La sesion cambio. Vuelve a abrir este contenido desde tu cuenta actual.', this.tr('STORY_COMPOSER.SESSION_ERROR', 'Tu sesión cambió. Vuelve a iniciar sesión e inténtalo otra vez.')],
          ['El servidor aún no permite historias con música. Conservamos tu borrador; vuelve a intentar cuando se actualice.', 'El servidor aún no permite historias con música. Conservamos tu borrador; vuelve a intentar cuando se actualice.'],
        ]);
        const safeMessage = error instanceof Error ? safeErrors.get(error.message) : undefined;
        if (safeMessage) {
          this.error = safeMessage;
        }
        const status = typeof error === 'object' && error !== null && 'status' in error
          ? Number((error as { status: unknown }).status) : NaN;
        if (status === 402) {
          this.error = this.tr('STORY_COMPOSER.STORAGE_BLOCKED', 'No se puede guardar el archivo: el almacenamiento necesita atención del administrador. Conservamos tu borrador.');
        } else if (status === 0) {
          this.error += ' ' + this.tr('STORY_COMPOSER.CONNECTION_ERROR', 'Comprueba tu conexión y vuelve a intentarlo.');
        } else if (status >= 500 || status === 429) {
          this.error += ' ' + this.tr('STORY_COMPOSER.SERVICE_BUSY', 'El servicio no está disponible en este momento. Reintenta en unos instantes.');
        } else if (status === 413) {
          this.error += ' ' + this.tr('STORY_COMPOSER.FILE_TOO_LARGE', 'El archivo supera el tamaño permitido. Elige uno más pequeño.');
        } else if (status === 401 || status === 403) {
          this.error += ' ' + this.tr('STORY_COMPOSER.ACCESS_ERROR', 'No se pudo autorizar la publicación. Actualiza tu sesión y revisa la audiencia.');
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private publicationStillCurrent(userId: string, deviceId: string, generation: number): boolean {
    const current = this.auth.session();
    return this.isOpen && generation === this.generation && current?.user.id === userId && current?.device.id === deviceId;
  }

  private async editedImageFile(): Promise<File | null> {
    const file = this.file;
    if (!file || this.mediaKind !== 'image' || (!this.imageRotation && !this.imageCrop)) return file;
    const image = new Image();
    image.src = this.previewUrl;
    await image.decode();
    const oddTurn = this.imageRotation % 180 !== 0;
    const width = oddTurn ? image.naturalHeight : image.naturalWidth;
    const height = oddTurn ? image.naturalWidth : image.naturalHeight;
    const scale = Math.min(1, 1920 / Math.max(width, height));
    const rotated = document.createElement('canvas');
    rotated.width = Math.max(1, Math.round(width * scale));
    rotated.height = Math.max(1, Math.round(height * scale));
    const context = rotated.getContext('2d');
    if (!context) throw new Error('canvas-unavailable');
    context.translate(rotated.width / 2, rotated.height / 2);
    context.rotate(this.imageRotation * Math.PI / 180);
    context.drawImage(image, -image.naturalWidth * scale / 2, -image.naturalHeight * scale / 2, image.naturalWidth * scale, image.naturalHeight * scale);
    let output = rotated;
    if (this.imageCrop) {
      output = document.createElement('canvas');
      const aspect = 9 / 16;
      const cropWidth = Math.min(rotated.width, rotated.height * aspect);
      const cropHeight = cropWidth / aspect;
      output.width = Math.max(1, Math.round(cropWidth));
      output.height = Math.max(1, Math.round(cropHeight));
      const outputContext = output.getContext('2d');
      if (!outputContext) throw new Error('canvas-unavailable');
      outputContext.drawImage(rotated, (rotated.width - cropWidth) / 2, (rotated.height - cropHeight) / 2, cropWidth, cropHeight, 0, 0, output.width, output.height);
    }
    return new File([await this.canvasBlob(output)], file.name.replace(/\.[^.]+$/, '') + '-story.jpg', { type: 'image/jpeg' });
  }

  private canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('image-encode-failed')), 'image/jpeg', .88));
  }

  private cameraError(error: unknown): string {
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return this.tr('STORY_COMPOSER.PERMISSION_ERROR', 'Permite el acceso a la cámara o al micrófono en los ajustes del dispositivo, o elige un archivo de tu galería.');
    }
    if (name === 'NotReadableError') return this.tr('STORY_COMPOSER.CAMERA_BUSY', 'La cámara está en uso. Cierra la otra captura o elige una foto de tu galería.');
    return this.tr('STORY_COMPOSER.CAMERA_ERROR', 'La cámara no está disponible aquí. Puedes usar la cámara del dispositivo o tu galería.');
  }

  private resetDraft(): void {
    this.draftMedia?.nativeElement.pause();
    this.releaseCapture();
    this.releasePreview();
    this.removeMusic();
    if (this.captionFocusTimer !== null) window.clearTimeout(this.captionFocusTimer);
    this.captionFocusTimer = null;
    this.mode = 'choose';
    this.file = null;
    this.mediaKind = '';
    this.text = '';
    this.audience = 'contacts';
    this.visibility = 'Contacts';
    this.durationSeconds = 86400;
    this.viewOnce = false;
    this.settingsOpen = false;
    this.imageLoading = false;
    this.imageRotation = 0;
    this.imageCrop = false;
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.confirmingDiscard = false;
    this.error = '';
    this.publicationFailed = false;
  }

  private releasePreview(): void {
    if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
    this.previewUrl = '';
  }

  private releaseCapture(): void {
    ++this.generation;
    this.stopRecordingTimer();
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    this.recording = false;
    this.cameraBusy = false;
    this.recordingChunks = [];
    this.recordingBytes = 0;
  }

  private stopRecordingTimer(): void {
    if (this.recordingTimer !== null) window.clearInterval(this.recordingTimer);
    this.recordingTimer = null;
  }

  private tr(key: string, fallback: string): string { return this.translate.instant(key, fallback); }
}
