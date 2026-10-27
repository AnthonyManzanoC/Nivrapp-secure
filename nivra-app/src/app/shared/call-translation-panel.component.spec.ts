import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { componentOnReady } from '@ionic/core/components';
import { CallTranslationPanelComponent } from './call-translation-panel.component';
import { CallTranslationService } from '../core/services/call-translation.service';
import { CallsService } from '../core/services/calls.service';
import { ChatService } from '../core/services/chat.service';
import { TranslateService } from '../core/services/translate.service';

describe('call translation controls and phone layout', () => {
  let fixture: ComponentFixture<CallTranslationPanelComponent>;
  let translation: any;
  let modal: HTMLIonModalElement;
  beforeEach(async () => {
    translation = { enabled: signal(true), mode: signal('subtitles'), source: signal('en-US'), target: signal('es-ES'), peerId: signal('peer'),
      active: signal(false), busy: signal(false), error: signal(''), caption: signal(null), peers: signal([['peer', {}]]),
      configure: jasmine.createSpy(), start: jasmine.createSpy().and.resolveTo(), stop: jasmine.createSpy() };
    translation.hasSubtitles = computed(() => translation.mode() !== 'voice');
    TestBed.configureTestingModule({ imports: [CallTranslationPanelComponent], providers: [
      provideIonicAngular({ animated: false }), { provide: CallTranslationService, useValue: translation },
      { provide: CallsService, useValue: { phase: signal('connected') } },
      { provide: ChatService, useValue: { participantDisplayName: () => 'Amiga' } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    fixture = TestBed.createComponent(CallTranslationPanelComponent); fixture.detectChanges();
    modal = fixture.nativeElement.querySelector('ion-modal');
    await fixture.whenStable(); await new Promise<void>(resolve => componentOnReady(modal, () => resolve()));
  });
  afterEach(async () => { await modal.dismiss(); fixture.destroy(); });

  it('shows the call button only when the account setting allows translation and closes its sheet when disabled', () => {
    expect(fixture.nativeElement.querySelector('.translation-button')).not.toBeNull();
    fixture.componentInstance.open = true;
    translation.enabled.set(false); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.translation-button')).toBeNull();
    expect(modal.isOpen).toBeFalse(); expect(fixture.componentInstance.open).toBeFalse();
    translation.enabled.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.translation-button')).not.toBeNull();
    expect(fixture.componentInstance.open).toBeFalse();
    expect(translation.start).not.toHaveBeenCalled();
  });

  it('offers all three modes and keeps activation a deliberate user action', async () => {
    expect(translation.start).not.toHaveBeenCalled(); await modal.present();
    const select = modal.querySelector('select')!;
    expect(Array.from(select.options).map(option => option.value)).toEqual(['subtitles', 'voice', 'both']);
    select.value = 'both'; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(translation.configure).toHaveBeenCalledWith('both', 'en-US', 'es-ES');
    (modal.querySelector('.translation-start') as HTMLButtonElement).click();
    expect(translation.start).toHaveBeenCalledTimes(1);
  });
  it('keeps the action reachable in a scrollable sheet inside the available viewport', async () => {
    translation.error.set('Un motor local compatible es necesario. '.repeat(12)); fixture.detectChanges(); await modal.present();
    const sheet = modal.querySelector('.translation-sheet') as HTMLElement;
    const style = getComputedStyle(sheet);
    expect(style.overflowY).toBe('auto');
    expect(sheet.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight * .9 + 1);
    const action = modal.querySelector('.translation-start') as HTMLElement;
    action.scrollIntoView({ block: 'end' });
    const bounds = sheet.getBoundingClientRect(); const button = action.getBoundingClientRect();
    expect(button.bottom).toBeLessThanOrEqual(bounds.bottom + 1);
    expect(button.top).toBeGreaterThanOrEqual(bounds.top - 1);
  });
  it('shows captions only while enabled and keeps voice-only mode free of transcript text', () => {
    translation.caption.set({ original: 'private words', text: 'palabras privadas', final: true }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.translation-caption')).toBeNull();
    translation.active.set(true); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.translation-caption').textContent).toContain('palabras privadas');
    translation.mode.set('voice'); fixture.detectChanges(); expect(fixture.nativeElement.querySelector('.translation-caption')).toBeNull();
  });
});
