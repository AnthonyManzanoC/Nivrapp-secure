import { CommonModule } from '@angular/common';
import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  HostListener,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';

interface CropPointer {
  x: number;
  y: number;
}

@Component({
  selector: 'app-image-cropper',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './image-cropper.component.html',
  styleUrls: ['./image-cropper.component.scss'],
})
export class ImageCropperComponent implements AfterViewInit, OnChanges, OnDestroy {
  @ViewChild('overlayRoot') private overlayRoot?: ElementRef<HTMLElement>;
  @ViewChild('viewport') private viewport?: ElementRef<HTMLElement>;
  @ViewChild('sourceImage') private sourceImage?: ElementRef<HTMLImageElement>;

  @Input() isOpen = false;
  @Input() file: File | null = null;
  @Input() title = 'Ajustar foto';
  @Input() subject = 'perfil';
  @Output() cancelled = new EventEmitter<void>();
  @Output() cropped = new EventEmitter<string>();

  imageUrl = '';
  zoom = 1;
  offsetX = 0;
  offsetY = 0;
  loading = false;
  saving = false;
  error = '';

  private naturalWidth = 0;
  private naturalHeight = 0;
  private baseScale = 1;
  private cropSize = 0;
  private readonly pointers = new Map<number, CropPointer>();
  private lastDragPoint: CropPointer | null = null;
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private objectUrl = '';
  private viewReady = false;
  private originalParent: Node | null = null;
  private originalNextSibling: Node | null = null;

  ngAfterViewInit(): void {
    this.viewReady = true;
    if (this.isOpen) {
      this.portalToBody();
      if (this.file) {
        this.prepareFile(this.file);
      }
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!this.viewReady) {
      return;
    }
    if (changes['isOpen'] && this.isOpen) {
      this.portalToBody();
    }
    if ((changes['file'] || changes['isOpen']) && this.isOpen && this.file) {
      this.prepareFile(this.file);
    }
    if (changes['isOpen'] && !this.isOpen) {
      this.resetInteraction();
      this.releaseObjectUrl();
      this.restoreOverlay();
    }
  }

  ngOnDestroy(): void {
    this.releaseObjectUrl();
    this.restoreOverlay();
  }

  /**
   * Escapa de cualquier contexto de apilamiento creado por modales padres.
   * Mover el nodo conserva la instancia Angular y, por tanto, el archivo y sus eventos.
   */
  private portalToBody(): void {
    const root = this.overlayRoot?.nativeElement;
    if (!root || typeof document === 'undefined') {
      return;
    }

    this.syncTheme(root);
    if (root.parentNode !== document.body) {
      this.originalParent = root.parentNode;
      this.originalNextSibling = root.nextSibling;
      document.body.appendChild(root);
    }
    document.body.classList.add('nivra-cropper-open');
  }

  private restoreOverlay(): void {
    const root = this.overlayRoot?.nativeElement;
    if (!root || typeof document === 'undefined') {
      return;
    }

    if (this.originalParent && root.parentNode === document.body) {
      const anchor = this.originalNextSibling?.parentNode === this.originalParent
        ? this.originalNextSibling
        : null;
      this.originalParent.insertBefore(root, anchor);
    }
    this.originalParent = null;
    this.originalNextSibling = null;

    const anotherCropperIsOpen = Array.from(document.querySelectorAll('.cropper-backdrop.is-open'))
      .some((element) => element !== root);
    if (!anotherCropperIsOpen) {
      document.body.classList.remove('nivra-cropper-open');
    }
  }

  private syncTheme(root: HTMLElement): void {
    const usesLightTheme = document.body.classList.contains('nivra-light-theme')
      || document.documentElement.classList.contains('nivra-light-theme');
    root.classList.toggle('light-theme', usesLightTheme);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen && !this.saving) {
      this.cancel();
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    if (this.isOpen && this.naturalWidth) {
      requestAnimationFrame(() => this.measureCropArea());
    }
  }

  onImageLoaded(event: Event): void {
    const image = event.target as HTMLImageElement;
    this.naturalWidth = image.naturalWidth;
    this.naturalHeight = image.naturalHeight;
    if (!this.naturalWidth || !this.naturalHeight) {
      this.fail('No se pudo leer esta imagen. Prueba con otra foto.');
      return;
    }
    requestAnimationFrame(() => {
      this.measureCropArea(true);
      this.loading = false;
    });
  }

  onImageError(): void {
    this.fail('No se pudo leer esta imagen. Prueba con JPG, PNG o WebP.');
  }

  onPointerDown(event: PointerEvent): void {
    if (this.loading || this.error) {
      return;
    }
    event.preventDefault();
    this.viewport?.nativeElement.setPointerCapture(event.pointerId);
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1) {
      this.lastDragPoint = { x: event.clientX, y: event.clientY };
    } else if (this.pointers.size === 2) {
      this.pinchStartDistance = this.pointerDistance();
      this.pinchStartZoom = this.zoom;
      this.lastDragPoint = null;
    }
  }

  onPointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) {
      return;
    }
    event.preventDefault();
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.pointers.size === 1 && this.lastDragPoint) {
      this.offsetX += event.clientX - this.lastDragPoint.x;
      this.offsetY += event.clientY - this.lastDragPoint.y;
      this.lastDragPoint = { x: event.clientX, y: event.clientY };
      this.constrainOffsets();
      return;
    }
    if (this.pointers.size === 2 && this.pinchStartDistance > 0) {
      const nextZoom = this.pinchStartZoom * (this.pointerDistance() / this.pinchStartDistance);
      this.setZoom(nextZoom);
    }
  }

  onPointerUp(event: PointerEvent): void {
    this.pointers.delete(event.pointerId);
    if (this.pointers.size === 1) {
      const point = [...this.pointers.values()][0];
      this.lastDragPoint = point ? { ...point } : null;
    } else {
      this.lastDragPoint = null;
    }
    if (this.pointers.size < 2) {
      this.pinchStartDistance = 0;
    }
  }

  onWheel(event: WheelEvent): void {
    if (this.loading || this.error) {
      return;
    }
    event.preventDefault();
    const viewport = this.viewport?.nativeElement;
    if (!viewport) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    const pointX = event.clientX - rect.left - rect.width / 2;
    const pointY = event.clientY - rect.top - rect.height / 2;
    const oldZoom = this.zoom;
    const nextZoom = this.clampZoom(oldZoom * Math.exp(-event.deltaY * 0.0015));
    const ratio = nextZoom / oldZoom;
    this.offsetX = pointX - ((pointX - this.offsetX) * ratio);
    this.offsetY = pointY - ((pointY - this.offsetY) * ratio);
    this.zoom = nextZoom;
    this.constrainOffsets();
  }

  onZoomInput(event: Event): void {
    this.setZoom(Number((event.target as HTMLInputElement).value));
  }

  reset(): void {
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.constrainOffsets();
  }

  cancel(): void {
    if (this.saving) {
      return;
    }
    this.cancelled.emit();
  }

  backdropClick(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.cancel();
    }
  }

  async confirm(): Promise<void> {
    const image = this.sourceImage?.nativeElement;
    const viewport = this.viewport?.nativeElement;
    if (!image || !viewport || !this.naturalWidth || !this.cropSize || this.saving) {
      return;
    }
    this.saving = true;
    this.error = '';
    try {
      const rect = viewport.getBoundingClientRect();
      const renderedScale = this.baseScale * this.zoom;
      const cropLeft = (rect.width - this.cropSize) / 2;
      const cropTop = (rect.height - this.cropSize) / 2;
      const imageLeft = (rect.width / 2) + this.offsetX - ((this.naturalWidth * renderedScale) / 2);
      const imageTop = (rect.height / 2) + this.offsetY - ((this.naturalHeight * renderedScale) / 2);
      const sourceSize = this.cropSize / renderedScale;
      const sourceX = Math.min(this.naturalWidth - sourceSize, Math.max(0, (cropLeft - imageLeft) / renderedScale));
      const sourceY = Math.min(this.naturalHeight - sourceSize, Math.max(0, (cropTop - imageTop) / renderedScale));
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 512;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('No se pudo preparar la imagen.');
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceSize,
        sourceSize,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      this.cropped.emit(this.encodeWithinLimit(canvas));
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'No se pudo recortar la imagen.';
    } finally {
      this.saving = false;
    }
  }

  imageTransform(): string {
    return `translate3d(calc(-50% + ${this.offsetX}px), calc(-50% + ${this.offsetY}px), 0) scale(${this.baseScale * this.zoom})`;
  }

  zoomLabel(): string {
    return `${Math.round(this.zoom * 100)}%`;
  }

  private prepareFile(file: File): void {
    this.releaseObjectUrl();
    this.resetInteraction();
    this.loading = true;
    this.error = '';
    this.objectUrl = URL.createObjectURL(file);
    this.imageUrl = this.objectUrl;
  }

  private resetInteraction(): void {
    this.zoom = 1;
    this.offsetX = 0;
    this.offsetY = 0;
    this.naturalWidth = 0;
    this.naturalHeight = 0;
    this.baseScale = 1;
    this.cropSize = 0;
    this.pointers.clear();
    this.lastDragPoint = null;
    this.pinchStartDistance = 0;
    this.error = '';
    this.loading = false;
  }

  private measureCropArea(resetPosition = false): void {
    const viewport = this.viewport?.nativeElement;
    if (!viewport || !this.naturalWidth || !this.naturalHeight) {
      return;
    }
    const rect = viewport.getBoundingClientRect();
    this.cropSize = Math.max(1, Math.min(rect.width, rect.height) - 32);
    this.baseScale = Math.max(this.cropSize / this.naturalWidth, this.cropSize / this.naturalHeight);
    if (resetPosition) {
      this.zoom = 1;
      this.offsetX = 0;
      this.offsetY = 0;
    }
    this.constrainOffsets();
  }

  private setZoom(value: number): void {
    this.zoom = this.clampZoom(value);
    this.constrainOffsets();
  }

  private clampZoom(value: number): number {
    return Math.min(4, Math.max(1, Number.isFinite(value) ? value : 1));
  }

  private constrainOffsets(): void {
    const displayedWidth = this.naturalWidth * this.baseScale * this.zoom;
    const displayedHeight = this.naturalHeight * this.baseScale * this.zoom;
    const maxX = Math.max(0, (displayedWidth - this.cropSize) / 2);
    const maxY = Math.max(0, (displayedHeight - this.cropSize) / 2);
    this.offsetX = Math.min(maxX, Math.max(-maxX, this.offsetX));
    this.offsetY = Math.min(maxY, Math.max(-maxY, this.offsetY));
  }

  private pointerDistance(): number {
    const [first, second] = [...this.pointers.values()];
    if (!first || !second) {
      return 0;
    }
    return Math.hypot(second.x - first.x, second.y - first.y);
  }

  private encodeWithinLimit(canvas: HTMLCanvasElement): string {
    let quality = 0.9;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);
    while (dataUrl.length > 340000 && quality > 0.58) {
      quality -= 0.07;
      dataUrl = canvas.toDataURL('image/jpeg', quality);
    }
    if (dataUrl.length > 350000) {
      throw new Error('La imagen sigue siendo muy grande. Prueba otra foto.');
    }
    return dataUrl;
  }

  private fail(message: string): void {
    this.loading = false;
    this.error = message;
  }

  private releaseObjectUrl(): void {
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
    }
    this.objectUrl = '';
    this.imageUrl = '';
  }
}
