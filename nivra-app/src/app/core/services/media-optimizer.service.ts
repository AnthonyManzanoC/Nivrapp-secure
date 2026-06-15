import { Injectable } from '@angular/core';

export const E2EE_UPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;

const IMAGE_MAX_EDGE = 1280;
const IMAGE_QUALITY = 0.8;
const VIDEO_TRANSCODE_TRIGGER_BYTES = 24 * 1024 * 1024;
const VIDEO_TARGET_BYTES = 14 * 1024 * 1024;
const VIDEO_MAX_EDGE = 960;
const VIDEO_FRAME_RATE = 24;
const VIDEO_MIN_BITS_PER_SECOND = 280_000;
const VIDEO_MAX_BITS_PER_SECOND = 900_000;
const VIDEO_AUDIO_BITS_PER_SECOND = 64_000;
const VIDEO_MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export type EncryptedUploadMode = 'media' | 'document';

export interface PreparedEncryptedUpload {
  file: File;
  originalFile: File;
  optimized: boolean;
  originalSize: number;
}

@Injectable({ providedIn: 'root' })
export class MediaOptimizerService {
  async prepareForEncryptedUpload(
    file: File,
    options: {
      mode: EncryptedUploadMode;
      maxBytes?: number;
    },
  ): Promise<PreparedEncryptedUpload> {
    const maxBytes = options.maxBytes ?? E2EE_UPLOAD_LIMIT_BYTES;
    if (options.mode === 'document') {
      this.assertWithinLimit(file, maxBytes);
      return this.asPrepared(file, file, false);
    }

    if (this.isVideo(file)) {
      const optimized = await this.compressVideo(file).catch(() => file);
      this.assertWithinLimit(optimized, maxBytes);
      return this.asPrepared(optimized, file, optimized !== file);
    }

    if (!this.isCompressibleImage(file)) {
      this.assertWithinLimit(file, maxBytes);
      return this.asPrepared(file, file, false);
    }

    const optimized = await this.compressImage(file).catch(() => file);
    this.assertWithinLimit(optimized, maxBytes);
    return this.asPrepared(optimized, file, optimized !== file);
  }

  videoCaptureConstraints(): MediaStreamConstraints {
    return {
      audio: true,
      video: {
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 24, max: 30 },
      },
    };
  }

  videoRecorderOptions(mimeType = ''): MediaRecorderOptions {
    return {
      ...(mimeType ? { mimeType } : {}),
      audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND,
      videoBitsPerSecond: VIDEO_MAX_BITS_PER_SECOND,
    };
  }

  private async compressImage(file: File): Promise<File> {
    const image = await this.loadImage(file);
    const { width, height } = this.fitWithin(image.naturalWidth || image.width, image.naturalHeight || image.height);
    if (!width || !height) {
      return file;
    }

    const webp = await this.renderImage(image, width, height, 'image/webp');
    const blob = webp?.type === 'image/webp'
      ? webp
      : await this.renderImage(image, width, height, 'image/jpeg');
    if (!blob?.size || blob.size >= file.size) {
      return file;
    }

    return new File([blob], this.optimizedFileName(file.name, blob.type), {
      type: blob.type || 'image/jpeg',
      lastModified: Date.now(),
    });
  }

  private async compressVideo(file: File): Promise<File> {
    if (file.size <= VIDEO_TRANSCODE_TRIGGER_BYTES || !this.canTranscodeVideo()) {
      return file;
    }

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = url;

    let animationFrame = 0;
    let drawing = false;
    let sourceStream: MediaStream | null = null;
    let canvasStream: MediaStream | null = null;
    let outputStream: MediaStream | null = null;

    try {
      await this.waitForVideoMetadata(video);
      const { width, height } = this.fitWithin(video.videoWidth, video.videoHeight, VIDEO_MAX_EDGE);
      if (!width || !height) {
        return file;
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) {
        return file;
      }

      canvasStream = canvas.captureStream(VIDEO_FRAME_RATE);
      sourceStream = this.captureVideoElementStream(video);
      outputStream = new MediaStream([
        ...canvasStream.getVideoTracks(),
        ...(sourceStream?.getAudioTracks() ?? []),
      ]);

      const mimeType = this.bestVideoMimeType();
      const recorder = new MediaRecorder(outputStream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: VIDEO_AUDIO_BITS_PER_SECOND,
        videoBitsPerSecond: this.videoBitsPerSecond(video.duration),
      });
      const chunks: Blob[] = [];
      const recorded = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data?.size) {
            chunks.push(event.data);
          }
        };
        recorder.onerror = (event) => {
          reject((event as Event & { error?: Error }).error ?? new Error('No se pudo optimizar el video.'));
        };
        recorder.onstop = () => {
          resolve(new Blob(chunks, { type: mimeType || chunks[0]?.type || 'video/webm' }));
        };
      });

      const draw = () => {
        if (!drawing) {
          return;
        }
        context.drawImage(video, 0, 0, width, height);
        animationFrame = requestAnimationFrame(draw);
      };

      video.currentTime = 0;
      recorder.start(1000);
      drawing = true;
      draw();
      await video.play();
      await this.waitForVideoEnded(video);
      drawing = false;
      if (recorder.state !== 'inactive') {
        recorder.stop();
      }

      const blob = await recorded;
      if (!blob.size || blob.size >= file.size) {
        return file;
      }

      return new File([blob], this.optimizedFileName(file.name, blob.type), {
        type: blob.type || 'video/webm',
        lastModified: Date.now(),
      });
    } finally {
      drawing = false;
      if (animationFrame) {
        cancelAnimationFrame(animationFrame);
      }
      video.pause();
      URL.revokeObjectURL(url);
      sourceStream?.getTracks().forEach((track) => track.stop());
      canvasStream?.getTracks().forEach((track) => track.stop());
      outputStream?.getTracks().forEach((track) => track.stop());
      video.removeAttribute('src');
      video.load();
    }
  }

  private loadImage(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.decoding = 'async';
      image.onload = () => {
        URL.revokeObjectURL(url);
        resolve(image);
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo optimizar la imagen.'));
      };
      image.src = url;
    });
  }

  private async renderImage(image: HTMLImageElement, width: number, height: number, mime: string): Promise<Blob | null> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    if (mime === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(image, 0, 0, width, height);
    return this.canvasToBlob(canvas, mime, IMAGE_QUALITY);
  }

  private canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality: number): Promise<Blob | null> {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), mime, quality);
    });
  }

  private fitWithin(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number } {
    const maxSide = Math.max(width, height);
    if (!Number.isFinite(maxSide) || maxSide <= 0) {
      return { width: 0, height: 0 };
    }
    const scale = Math.min(1, maxEdge / maxSide);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  private optimizedFileName(name: string, mime: string): string {
    const base = (name || 'nivra-media').replace(/\.[^.]+$/, '') || 'nivra-media';
    const extension = mime.startsWith('video/')
      ? (mime.includes('mp4') ? 'mp4' : 'webm')
      : mime === 'image/webp' ? 'webp' : 'jpg';
    return `${base}.${extension}`;
  }

  private waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('No se pudo leer el video.'));
      video.load();
    });
  }

  private waitForVideoEnded(video: HTMLVideoElement): Promise<void> {
    if (video.ended) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      video.onended = () => resolve();
      video.onerror = () => reject(new Error('No se pudo optimizar el video.'));
    });
  }

  private captureVideoElementStream(video: HTMLVideoElement): MediaStream | null {
    const source = video as HTMLVideoElement & {
      captureStream?: () => MediaStream;
      mozCaptureStream?: () => MediaStream;
    };
    return source.captureStream?.() ?? source.mozCaptureStream?.() ?? null;
  }

  private bestVideoMimeType(): string {
    return VIDEO_MIME_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
  }

  private canTranscodeVideo(): boolean {
    return typeof document !== 'undefined' &&
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function';
  }

  private videoBitsPerSecond(durationSeconds: number): number {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return VIDEO_MAX_BITS_PER_SECOND;
    }
    const targetBits = (VIDEO_TARGET_BYTES * 8) / Math.max(1, durationSeconds);
    const budget = Math.round(targetBits - VIDEO_AUDIO_BITS_PER_SECOND);
    return Math.max(VIDEO_MIN_BITS_PER_SECOND, Math.min(VIDEO_MAX_BITS_PER_SECOND, budget));
  }

  private isCompressibleImage(file: File): boolean {
    return this.isImage(file) && file.type !== 'image/gif';
  }

  private isImage(file: File): boolean {
    return file.type.startsWith('image/');
  }

  private isVideo(file: File): boolean {
    return file.type.startsWith('video/');
  }

  private assertWithinLimit(file: File, maxBytes: number): void {
    if (file.size > maxBytes) {
      throw new Error(`El archivo supera el limite robusto de cifrado local (${this.megabytes(maxBytes)}MB).`);
    }
  }

  private asPrepared(file: File, originalFile: File, optimized: boolean): PreparedEncryptedUpload {
    return {
      file,
      originalFile,
      optimized,
      originalSize: originalFile.size,
    };
  }

  private megabytes(bytes: number): number {
    return Math.round(bytes / (1024 * 1024));
  }
}
