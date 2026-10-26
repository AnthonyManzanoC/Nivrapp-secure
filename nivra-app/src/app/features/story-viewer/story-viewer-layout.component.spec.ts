import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { IonModal, provideIonicAngular } from '@ionic/angular/standalone';
import { componentOnReady } from '@ionic/core/components';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { StoryViewerComponent } from './story-viewer.component';

@Component({
  standalone: true,
  imports: [IonModal],
  template: '<ion-modal class="nivra-story-viewer-modal" [animated]="false"><ng-template><div></div></ng-template></ion-modal>',
})
class StoryModalLayoutHost {}

describe('story viewer available app area', () => {
  let fixture: ComponentFixture<StoryViewerComponent> | undefined;
  let bounds: HTMLDivElement | undefined;
  let ready: ReturnType<typeof signal<string>>;
  const photo = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  beforeEach(() => {
    ready = signal('');
    TestBed.configureTestingModule({
      imports: [StoryViewerComponent, StoryModalLayoutHost],
      providers: [
        provideIonicAngular({ animated: false }),
        { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
        { provide: SocialService, useValue: {
          storyReadyId: ready, storyOpenError: signal(''), storyOpening: signal(false),
          storyMediaError: () => '', storyMedia: () => ({ mime: 'image/gif', url: photo, name: 'Foto' }), isImage: () => true,
        } },
      ],
    });
  });
  afterEach(() => { fixture?.destroy(); bounds?.remove(); });

  const render = (width: number, height: number) => {
    bounds = document.createElement('div');
    bounds.style.cssText = `position:fixed;left:0;top:0;width:${width}px;height:${height}px;overflow:hidden;`;
    document.body.append(bounds);
    fixture = TestBed.createComponent(StoryViewerComponent);
    bounds.append(fixture.nativeElement);
    fixture.componentRef.setInput('story', { id: 'story', owner: { id: 'friend', displayName: 'Amiga' } });
    fixture.componentRef.setInput('payload', { type: 'media', media: { mime: 'image/gif' } });
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  for (const [width, height] of [[360, 640], [640, 280]]) {
    it(`keeps the loading viewer within the available ${width} × ${height} area`, () => {
      const host = render(width, height);
      const area = bounds!.getBoundingClientRect();
      const viewer = host.querySelector('.story-viewer')!.getBoundingClientRect();
      expect(viewer.width).toBeGreaterThan(0);
      expect(viewer.height).toBeGreaterThan(0);
      expect(viewer.left).toBeGreaterThanOrEqual(area.left - 1);
      expect(viewer.top).toBeGreaterThanOrEqual(area.top - 1);
      expect(viewer.right).toBeLessThanOrEqual(area.right + 1);
      expect(viewer.bottom).toBeLessThanOrEqual(area.bottom + 1);
      if (matchMedia('(max-width: 720px)').matches) {
        expect(viewer.width).toBeCloseTo(area.width, 0);
        expect(viewer.height).toBeCloseTo(area.height, 0);
      }
      expect(host.querySelector('.story-loading')).not.toBeNull();
    });
  }

  it('respects lateral safe areas and applies the top inset once above the controls', () => {
    const host = render(360, 640);
    host.style.setProperty('--ion-safe-area-left', '28px');
    host.style.setProperty('--ion-safe-area-right', '24px');
    host.style.setProperty('--ion-safe-area-top', '20px');
    const progress = getComputedStyle(host.querySelector('.story-progress')!);
    const header = getComputedStyle(host.querySelector('.story-viewer-top')!);
    const footer = getComputedStyle(host.querySelector('.story-action-bar')!);
    expect(progress.paddingTop).toBe('30px');
    expect(header.paddingTop).toBe('12px');
    for (const style of [progress, header, footer]) {
      expect(parseFloat(style.paddingLeft)).toBeGreaterThanOrEqual(28);
      expect(parseFloat(style.paddingRight)).toBeGreaterThanOrEqual(24);
    }
  });

  it('keeps a ready photo contained without cropping or stretching', () => {
    const host = render(360, 640);
    ready.set('story');
    fixture!.detectChanges();
    const image = host.querySelector('.story-viewer-body img')!;
    expect(image).not.toBeNull();
    expect(getComputedStyle(image).objectFit).toBe('contain');
  });

  it('does not inherit a white panel border in a light theme Ionic modal', async () => {
    const lightThemeBefore = document.body.classList.contains('nivra-light-theme');
    document.body.classList.add('nivra-light-theme');
    const modalFixture = TestBed.createComponent(StoryModalLayoutHost);
    try {
      modalFixture.detectChanges();
      const modal = modalFixture.nativeElement.querySelector('ion-modal') as HTMLIonModalElement;
      await modalFixture.whenStable();
      // Ionic standalone uses custom elements, whose readiness helper waits a
      // render frame instead of exposing the lazy-build element method.
      await new Promise<void>((resolve) => componentOnReady(modal, () => resolve()));
      const content = modal.shadowRoot!.querySelector('[part="content"]')!;
      const style = getComputedStyle(content);
      expect(style.borderTopWidth).toBe('0px');
      expect(style.borderLeftWidth).toBe('0px');
      expect(style.backgroundImage).toBe('none');
      expect(style.paddingTop).toBe('0px');
      expect(style.paddingLeft).toBe('0px');
    } finally {
      modalFixture.destroy();
      if (!lightThemeBefore) document.body.classList.remove('nivra-light-theme');
    }
  });
});
