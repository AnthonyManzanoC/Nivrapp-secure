import { Directive, ElementRef, Input, OnChanges, OnDestroy, inject } from '@angular/core';

@Directive({
  selector: 'video[appMediaStream],audio[appMediaStream]',
  standalone: true,
})
export class MediaStreamDirective implements OnChanges, OnDestroy {
  private readonly element = inject<ElementRef<HTMLMediaElement>>(ElementRef);
  private listeners: Array<() => void> = [];
  private readonly resume = () => {
    if (this.stream && document.visibilityState !== 'hidden') {
      void this.element.nativeElement.play().catch(() => undefined);
    }
  };

  @Input('appMediaStream') stream: MediaStream | null = null;

  ngOnChanges(): void {
    this.removeListeners();
    const node = this.element.nativeElement;
    if (node instanceof HTMLVideoElement) {
      node.playsInline = true;
      node.muted = node.hasAttribute('muted');
    }
    node.autoplay = true;
    if (node.srcObject !== this.stream) {
      node.srcObject = this.stream;
    }
    if (this.stream) {
      const listen = (target: EventTarget, name: string, handler: EventListener) => {
        target.addEventListener(name, handler);
        this.listeners.push(() => target.removeEventListener(name, handler));
      };
      const observed = new Set<MediaStreamTrack>();
      const watchTracks = () => {
        for (const track of this.stream?.getTracks() ?? []) {
          if (observed.has(track)) continue;
          observed.add(track);
          listen(track, 'unmute', this.resume);
        }
        this.resume();
      };
      listen(this.stream, 'addtrack', watchTracks);
      listen(node, 'loadedmetadata', this.resume);
      listen(node, 'canplay', this.resume);
      listen(node, 'pointerup', this.resume);
      listen(document, 'visibilitychange', this.resume);
      watchTracks();
    } else {
      this.releaseElement();
    }
  }

  ngOnDestroy(): void {
    this.removeListeners();
    this.releaseElement();
  }

  private removeListeners(): void {
    this.listeners.splice(0).forEach((remove) => remove());
  }

  private releaseElement(): void {
    const node = this.element.nativeElement;
    node.pause?.();
    node.srcObject = null;
    node.removeAttribute('src');
    node.load?.();
  }
}
