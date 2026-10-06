import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, HostListener, Input, NgZone, OnChanges, OnDestroy, Output, SimpleChanges, ViewChild, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonModal, IonSpinner } from '@ionic/angular/standalone';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { addIcons } from 'ionicons';
import { cameraOutline, checkmarkOutline, closeOutline, expandOutline, imageOutline, musicalNotesOutline, refreshOutline, sendOutline, settingsOutline, shieldCheckmarkOutline, textOutline, videocamOutline } from 'ionicons/icons';
import { Conversation } from '../../core/models/nivra.models';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { E2EE_UPLOAD_LIMIT_BYTES } from '../../core/services/media-optimizer.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { MediaStreamDirective } from '../media-stream.directive';

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
  confirmingDiscard = false;
  readonly native = Capacitor.isNativePlatform();
  readonly recordingSupported = typeof MediaRecorder !== 'undefined';
  private generation = 0;
  private closedEmitted = false;
  private dismissRequested = false;
  private recorder: MediaRecorder | null = null;
  private recordingChunks: Blob[] = [];
  private recordingBytes = 0;
  private recordingTimer: number | null = null;
  private captionFocusTimer: number | null = null;
  private recordingStartedAt = 0;
  private readonly onVisibilityChange = () => {
    if (document.visibilityState !== 'hidden' || !this.cameraStream) return;
    // Leaving the app must never leave a camera or microphone recording invisibly.
    this.zone.run(() => this.recording ? this.finishRecording() : this.leaveCamera());
  };

  readonly canDismiss = () => this.dismissRequested || (!this.busy && !this.hasDraft() && !this.cameraBusy);

  constructor() {
    addIcons({ cameraOutline, checkmarkOutline, closeOutline, expandOutline, imageOutline, musicalNotesOutline, refreshOutline, sendOutline, settingsOutline, shieldCheckmarkOutline, textOutline, videocamOutline });
    document.addEventListener('visibilitychange', this.onVisibilityChange);
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
    this.file = file;
    this.mediaKind = kind;
    this.previewUrl = URL.createObjectURL(file);
    this.imageRotation = 0;
    this.imageCrop = false;
    this.imageWidth = 0;
    this.imageHeight = 0;
    this.imageLoading = kind === 'image';
    this.error = '';
    this.mode = 'edit';
    return true;
  }

  removeFile(): void {
    if (this.busy) return;
    this.releasePreview();
    this.file = null;
    this.mediaKind = '';
    this.imageLoading = false;
    this.imageRotation = 0;
    this.imageCrop = false;
    this.imageWidth = 0;
    this.imageHeight = 0;
  }

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
    const targetAspect = 9 / 16;
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
    if (this.busy || this.social.publishing() || !this.hasDraft() || this.mode === 'camera' || this.imageLoading) return;
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
        visibility: group ? 'SelectedUsers' : this.visibility,
        durationSeconds: Number(this.durationSeconds), viewOnce: this.viewOnce, allowReposts: this.allowReposts,
        targetType: group ? 'group' : 'contacts', targetId: group?.id ?? null,
        allowedUserIds: group?.participants.filter((member) => !member.removedAt).map((member) => member.userId) ?? [],
      });
      if (!this.publicationStillCurrent(userId, deviceId, generation)) return;
      this.published.emit(this.social.storyDeliveryWarning() || this.tr('WORLD.NOTICE_STORY_PUBLISHED', 'Historia publicada.'));
      this.finishClose();
    } catch {
      if (this.publicationStillCurrent(userId, deviceId, generation)) {
        this.error = this.tr('STORY_COMPOSER.PUBLISH_ERROR', 'No se pudo publicar. Conservamos tu historia para que puedas intentarlo otra vez.');
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
    this.releaseCapture();
    this.releasePreview();
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
