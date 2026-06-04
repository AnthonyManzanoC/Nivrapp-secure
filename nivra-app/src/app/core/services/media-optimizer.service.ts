import { Injectable } from '@angular/core';

export const E2EE_UPLOAD_LIMIT_BYTES = 256 * 1024 * 1024;

const IMAGE_MAX_EDGE = 1280;
const IMAGE_QUALITY = 0.8;

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
      this.assertWithinLimit(file, maxBytes);
      return this.asPrepared(file, file, false);
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
      audioBitsPerSecond: 96_000,
      videoBitsPerSecond: 900_000,
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

  private fitWithin(width: number, height: number): { width: number; height: number } {
    const maxSide = Math.max(width, height);
    if (!Number.isFinite(maxSide) || maxSide <= 0) {
      return { width: 0, height: 0 };
    }
    const scale = Math.min(1, IMAGE_MAX_EDGE / maxSide);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  private optimizedFileName(name: string, mime: string): string {
    const base = (name || 'nivra-image').replace(/\.[^.]+$/, '') || 'nivra-image';
    const extension = mime === 'image/webp' ? 'webp' : 'jpg';
    return `${base}.${extension}`;
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
