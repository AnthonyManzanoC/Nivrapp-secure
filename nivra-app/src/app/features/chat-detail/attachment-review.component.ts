import { Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, arrowUndoOutline, checkmarkOutline, closeOutline, cropOutline, documentTextOutline, refreshOutline, sendOutline, trashOutline, videocamOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

export interface AttachmentReviewItem {
  id: number;
  file: File;
  originalFile: File;
  url: string | null;
}

/** Local previews only. The page owns files/object URLs and the encrypted upload. */
@Component({
  selector: 'app-attachment-review',
  standalone: true,
  imports: [FormsModule, IonIcon, IonSpinner, IonTextarea, TranslatePipe],
  templateUrl: './attachment-review.component.html',
  styleUrls: ['./attachment-review.component.scss'],
})
export class AttachmentReviewComponent implements OnChanges, OnDestroy {
  @Input() items: AttachmentReviewItem[] = [];
  @Input() caption = '';
  @Input() busy = false;
  @Input() media = false;
  @Input() error = '';
  @Output() captionChange = new EventEmitter<string>();
  @Output() closed = new EventEmitter<void>();
  @Output() submitted = new EventEmitter<void>();
  @Output() added = new EventEmitter<File[]>();
  @Output() removed = new EventEmitter<number>();
  @Output() replaced = new EventEmitter<{ id: number; file: File }>();
  @ViewChild('cropFrame') private cropFrame?: ElementRef<HTMLElement>;
  selectedId: number | null = null;
  failedId: number | null = null;
  editing = false;
  processing = false;
  editError = '';
  cropZoom = 1;
  cropX = 0;
  cropY = 0;
  private naturalWidth = 0;
  private naturalHeight = 0;
  private pointer: { id: number; x: number; y: number } | null = null;
  private generation = 0;
  private destroyed = false;
  private editSource: HTMLImageElement | null = null;
  private editUrls = new Set<string>();

  constructor() {
    addIcons({ addOutline, arrowUndoOutline, checkmarkOutline, closeOutline, cropOutline, documentTextOutline, refreshOutline, sendOutline, trashOutline, videocamOutline });
  }

  ngOnChanges(): void {
    if (!this.items.some(item => item.id === this.selectedId)) this.select(this.items[0]?.id ?? null);
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.generation;
    this.editUrls.forEach(url => URL.revokeObjectURL(url));
    this.editUrls.clear();
    if (this.editSource) this.editSource.src = '';
    this.editSource = null;
  }

  selected(): AttachmentReviewItem | undefined { return this.items.find(item => item.id === this.selectedId) ?? this.items[0]; }
  image(item: AttachmentReviewItem): boolean { return item.file.type.startsWith('image/'); }
  video(item: AttachmentReviewItem): boolean { return item.file.type.startsWith('video/'); }
  editable(item: AttachmentReviewItem): boolean { return /^(image\/(jpeg|png|webp))$/i.test(item.file.type) && this.failedId !== item.id; }
  extension(file: File): string { return file.name.split('.').pop()?.slice(0, 8).toUpperCase() || 'FILE'; }
  size(file: File): string { return file.size < 1024 * 1024 ? `${Math.max(1, Math.round(file.size / 1024))} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`; }

  select(id: number | null): void {
    if (this.processing || this.busy) return;
    this.selectedId = id;
    this.failedId = null;
    this.cancelCrop();
    this.editError = '';
  }

  addFiles(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (files.length && !this.busy && !this.processing) this.added.emit(files);
  }

  beginCrop(): void {
    const item = this.selected();
    if (!item || !this.editable(item) || this.busy || this.processing) return;
    this.editing = true;
    this.naturalWidth = this.naturalHeight = 0;
    this.cropZoom = 1;
    this.cropX = this.cropY = 0;
    this.editError = '';
  }

  cancelCrop(): void { this.editing = false; this.pointer = null; }

  imageLoaded(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.naturalWidth = image.naturalWidth;
    this.naturalHeight = image.naturalHeight;
    this.constrainCrop();
  }

  cropTransform(): string { return `translate(-50%, -50%) translate(${this.cropX}px, ${this.cropY}px) scale(${this.cropZoom})`; }
  cropImageSize(dimension: 'width' | 'height'): number | null {
    const side = this.cropFrame?.nativeElement.clientWidth ?? 0;
    if (!side || !this.naturalWidth || !this.naturalHeight) return null;
    const scale = Math.max(side / this.naturalWidth, side / this.naturalHeight);
    return (dimension === 'width' ? this.naturalWidth : this.naturalHeight) * scale;
  }

  cropPointerDown(event: PointerEvent): void {
    if (!this.editing || this.processing) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }

  cropPointerMove(event: PointerEvent): void {
    if (this.pointer?.id !== event.pointerId) return;
    this.cropX += event.clientX - this.pointer.x;
    this.cropY += event.clientY - this.pointer.y;
    this.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    this.constrainCrop();
  }

  cropPointerEnd(): void { this.pointer = null; }
  zoomChanged(value: string): void { this.cropZoom = Number(value); this.constrainCrop(); }
  moveCrop(x: number, y: number, event: Event): void { event.preventDefault(); this.cropX += x; this.cropY += y; this.constrainCrop(); }

  private constrainCrop(): void {
    const side = this.cropFrame?.nativeElement.clientWidth ?? 0;
    if (!side || !this.naturalWidth || !this.naturalHeight) return;
    const scale = Math.max(side / this.naturalWidth, side / this.naturalHeight) * this.cropZoom;
    const maxX = Math.max(0, (this.naturalWidth * scale - side) / 2);
    const maxY = Math.max(0, (this.naturalHeight * scale - side) / 2);
    this.cropX = Math.max(-maxX, Math.min(maxX, this.cropX));
    this.cropY = Math.max(-maxY, Math.min(maxY, this.cropY));
  }

  async editImage(operation: 'rotate' | 'crop'): Promise<void> {
    const item = this.selected();
    if (!item || !this.editable(item) || this.processing || this.busy) return;
    const request = ++this.generation;
    const file = item.file;
    const side = this.cropFrame?.nativeElement.clientWidth ?? 0;
    const crop = { zoom: this.cropZoom, x: this.cropX, y: this.cropY, side };
    this.processing = true;
    this.editError = '';
    const url = URL.createObjectURL(file);
    this.editUrls.add(url);
    const image = new Image();
    this.editSource = image;
    try {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('image'));
        image.src = url;
      });
      if (!image.naturalWidth || !image.naturalHeight) throw new Error('image');
      if (this.destroyed || request !== this.generation) return;
      if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('image-size');
      const canvas = document.createElement('canvas');
      let sourceX = 0, sourceY = 0, sourceSize = 0;
      if (operation === 'crop') {
        if (!crop.side) throw new Error('crop');
        const scale = Math.max(crop.side / image.naturalWidth, crop.side / image.naturalHeight) * crop.zoom;
        sourceSize = crop.side / scale;
        sourceX = Math.max(0, Math.min(image.naturalWidth - sourceSize, (image.naturalWidth - sourceSize) / 2 - crop.x / scale));
        sourceY = Math.max(0, Math.min(image.naturalHeight - sourceSize, (image.naturalHeight - sourceSize) / 2 - crop.y / scale));
        canvas.width = canvas.height = Math.max(1, Math.min(2048, Math.round(sourceSize)));
      } else {
        // Bound canvas memory on phones, without upscaling the source.
        const scale = Math.min(1, 2560 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.height = Math.max(1, Math.round(image.naturalWidth * scale));
      }
      const context = canvas.getContext('2d');
      if (!context) throw new Error('canvas');
      if (operation === 'crop') context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, canvas.width, canvas.height);
      else { context.translate(canvas.width, 0); context.rotate(Math.PI / 2); context.drawImage(image, 0, 0, canvas.height, canvas.width); }
      const mime = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, mime, .92));
      if (!blob?.size) throw new Error('encode');
      if (this.destroyed || request !== this.generation || this.selected()?.id !== item.id || this.selected()?.file !== file) return;
      const name = file.name.replace(/\.[^.]+$/, '') + (mime === 'image/png' ? '.png' : '.jpg');
      this.replaced.emit({ id: item.id, file: new File([blob], name, { type: mime, lastModified: Date.now() }) });
      this.cancelCrop();
    } catch {
      if (!this.destroyed && request === this.generation) this.editError = 'CHAT.ERROR_EDIT_IMAGE';
    } finally {
      URL.revokeObjectURL(url);
      this.editUrls.delete(url);
      if (this.editSource === image) this.editSource = null;
      if (!this.destroyed && request === this.generation) this.processing = false;
    }
  }
}
