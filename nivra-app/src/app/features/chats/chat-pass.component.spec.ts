import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { TranslateService } from '../../core/services/translate.service';
import { ChatPassComponent, chatPassUrl } from './chat-pass.component';

describe('Chat pass', () => {
  it('always shares a public HTTPS URL, including aliases that need URL encoding', () => {
    expect(chatPassUrl('maria+team')).toBe('https://nivrapp-secure.vercel.app/contact?alias=maria%2Bteam');
  });

  it('clears an open pass if the active account changes and blocks its copy action', async () => {
    const session = signal<any>({ user: { id: 'me', alias: 'maria' } });
    const copyToClipboard = jasmine.createSpy().and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } },
      { provide: NativeDeviceService, useValue: { copyToClipboard } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    const component = TestBed.runInInjectionContext(() => new ChatPassComponent());
    session.set({ user: { id: 'other', alias: 'other' } });
    TestBed.flushEffects();
    await component.copy();
    expect(component.modalOpen).toBeFalse();
    expect(component.qr).toBe('');
    expect(copyToClipboard).not.toHaveBeenCalled();
    component.ngOnDestroy();
  });
});
