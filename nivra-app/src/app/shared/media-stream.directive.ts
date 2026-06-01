import { Directive, ElementRef, Input, OnChanges, OnDestroy, inject } from '@angular/core';

@Directive({
  selector: 'video[appMediaStream],audio[appMediaStream]',
  standalone: true,
})
export class MediaStreamDirective implements OnChanges, OnDestroy {
  private readonly element = inject<ElementRef<HTMLMediaElement>>(ElementRef);

  @Input('appMediaStream') stream: MediaStream | null = null;

  ngOnChanges(): void {
    const node = this.element.nativeElement;
    if (node.srcObject !== this.stream) {
      node.srcObject = this.stream;
    }
    if (this.stream) {
      void node.play?.().catch(() => undefined);
    }
  }

  ngOnDestroy(): void {
    this.element.nativeElement.srcObject = null;
  }
}
