import { booleanAttribute, Directive, ElementRef, inject, input, OnDestroy, signal } from '@angular/core';
import { SystemUiService } from '../core/services/system-ui.service';

@Directive({
  selector: 'ion-modal[nivraDarkViewer]',
  standalone: true,
  host: {
    '[class.nivra-dark-viewer-modal]': 'enabled() || presentingDark()',
    '(ionModalWillPresent)': 'willPresent($event)',
    '(ionModalDidDismiss)': 'didDismiss($event)',
  },
})
export class DarkViewerBarsDirective implements OnDestroy {
  readonly enabled = input(true, { alias: 'nivraDarkViewer', transform: booleanAttribute });
  readonly presentingDark = signal(false);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly systemUi = inject(SystemUiService);
  private release: (() => void) | null = null;

  willPresent(event: Event): void {
    if (event.target !== this.host.nativeElement || !this.enabled() || this.release) return;
    this.release = this.systemUi.acquireDarkOverlay();
    this.presentingDark.set(true);
  }

  didDismiss(event: Event): void {
    if (event.target === this.host.nativeElement) this.releaseBars();
  }

  ngOnDestroy(): void {
    this.releaseBars();
  }

  private releaseBars(): void {
    this.release?.();
    this.release = null;
    this.presentingDark.set(false);
  }
}
