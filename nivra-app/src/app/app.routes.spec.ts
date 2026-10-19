import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { landingGuest } from './app.routes';
import { AuthService } from './core/services/auth.service';

describe('landing entry guard', () => {
  let restoreSession: jasmine.Spy;
  let nativePlatform: jasmine.Spy;
  let desktopBridge: PropertyDescriptor | undefined;

  beforeEach(() => {
    desktopBridge = Object.getOwnPropertyDescriptor(window, 'nivraSecureVault');
    Reflect.deleteProperty(window, 'nivraSecureVault');
    nativePlatform = spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    restoreSession = jasmine.createSpy('ensureSessionRestored').and.resolveTo(false);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: AuthService, useValue: { ensureSessionRestored: restoreSession } },
      ],
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nivraSecureVault');
    if (desktopBridge) Object.defineProperty(window, 'nivraSecureVault', desktopBridge);
  });

  const enter = () => TestBed.runInInjectionContext(landingGuest);
  const destination = (result: boolean | UrlTree) => result instanceof UrlTree
    ? TestBed.inject(Router).serializeUrl(result)
    : result;

  it('shows the landing to a browser guest after restoring the session', async () => {
    expect(await enter()).toBeTrue();
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('sends a restored browser session directly to chats', async () => {
    restoreSession.and.resolveTo(true);
    expect(destination(await enter())).toBe('/app/chats');
  });

  it('waits for session restoration before deciding the browser entry', async () => {
    let complete!: (authenticated: boolean) => void;
    restoreSession.and.returnValue(new Promise<boolean>(resolve => complete = resolve));
    let settled = false;
    const pending = enter().then(result => { settled = true; return result; });
    await Promise.resolve();
    expect(settled).toBeFalse();
    complete(true);
    expect(destination(await pending)).toBe('/app/chats');
  });

  it('keeps the direct app entry on native platforms', async () => {
    nativePlatform.and.returnValue(true);
    expect(destination(await enter())).toBe('/app/chats');
    expect(restoreSession).not.toHaveBeenCalled();
  });

  it('keeps the direct app entry in the Electron desktop shell', async () => {
    Object.defineProperty(window, 'nivraSecureVault', { configurable: true, value: {} });
    expect(destination(await enter())).toBe('/app/chats');
    expect(restoreSession).not.toHaveBeenCalled();
  });
});
