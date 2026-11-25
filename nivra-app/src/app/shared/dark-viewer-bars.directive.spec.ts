import { Component, CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SystemUiService } from '../core/services/system-ui.service';
import { DarkViewerBarsDirective } from './dark-viewer-bars.directive';

@Component({
  imports: [DarkViewerBarsDirective],
  schemas: [CUSTOM_ELEMENTS_SCHEMA],
  template: `
    <ion-modal nivraDarkViewer><button>Child</button></ion-modal>
    <ion-modal [nivraDarkViewer]="privateAudio"></ion-modal>
  `,
})
class DarkViewerTestHost {
  privateAudio = false;
}

describe('Private viewer system bars', () => {
  const fire = (target: HTMLElement, type: string) =>
    target.dispatchEvent(new CustomEvent(type, { bubbles: true }));

  function setup() {
    const fixture = TestBed.createComponent(DarkViewerTestHost);
    fixture.detectChanges();
    const modals = fixture.nativeElement.querySelectorAll('ion-modal') as NodeListOf<HTMLElement>;
    const text = modals[0];
    const audio = modals[1];
    return { fixture, text, audio, ui: TestBed.inject(SystemUiService) };
  }

  it('holds the contrast lease through dismissal and releases it when no viewer remains', () => {
    const { fixture, text, audio, ui } = setup();
    fire(text, 'ionModalWillPresent');
    expect(ui.darkOverlay()).toBeTrue();
    fixture.componentInstance.privateAudio = true;
    fixture.detectChanges();
    fire(audio, 'ionModalWillPresent');
    fire(text, 'ionModalDidDismiss');
    expect(ui.darkOverlay()).toBeTrue();

    fixture.componentInstance.privateAudio = false;
    fixture.detectChanges();
    expect(audio.classList.contains('nivra-dark-viewer-modal')).toBeTrue();
    fire(audio, 'ionModalDidDismiss');
    fixture.detectChanges();
    expect(audio.classList.contains('nivra-dark-viewer-modal')).toBeFalse();
    expect(ui.darkOverlay()).toBeFalse();
  });

  it('ignores ordinary audio and bubbled inner overlays, and cleans up on account or route teardown', () => {
    const { fixture, text, audio, ui } = setup();
    fire(audio, 'ionModalWillPresent');
    fire(text.querySelector('button')!, 'ionModalWillPresent');
    expect(ui.darkOverlay()).toBeFalse();
    fire(text, 'ionModalWillPresent');
    fire(text.querySelector('button')!, 'ionModalDidDismiss');
    expect(ui.darkOverlay()).toBeTrue();
    fixture.destroy();
    expect(ui.darkOverlay()).toBeFalse();
  });
});
