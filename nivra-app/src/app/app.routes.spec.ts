import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, provideRouter } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { guest, landingGuest, welcomeGuest } from './app.routes';
import { AuthService } from './core/services/auth.service';
import { NativeOnboardingService } from './core/services/native-onboarding.service';

describe('web and packaged app entry guards', () => {
  let restoreSession: jasmine.Spy;
  let nativePlatform: jasmine.Spy;
  let completed: jasmine.Spy;
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
    completed = spyOn(TestBed.inject(NativeOnboardingService), 'isComplete').and.returnValue(false);
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nivraSecureVault');
    if (desktopBridge) Object.defineProperty(window, 'nivraSecureVault', desktopBridge);
  });

  const enter = (guard = landingGuest) => TestBed.runInInjectionContext(guard);
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

  it('shows the welcome instead of the website on first native launch', async () => {
    nativePlatform.and.returnValue(true);
    expect(destination(await enter())).toBe('/welcome');
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('shows the welcome instead of the website on first Electron launch', async () => {
    Object.defineProperty(window, 'nivraSecureVault', { configurable: true, value: {} });
    expect(destination(await enter())).toBe('/welcome');
    expect(restoreSession).toHaveBeenCalledTimes(1);
  });

  it('opens auth directly after native onboarding has been completed', async () => {
    nativePlatform.and.returnValue(true);
    completed.and.returnValue(true);
    expect(destination(await enter())).toBe('/auth');
    expect(await enter(guest)).toBeTrue();
    expect(destination(await enter(welcomeGuest))).toBe('/auth');
  });

  it('opens auth directly after Electron onboarding has been completed', async () => {
    Object.defineProperty(window, 'nivraSecureVault', { configurable: true, value: {} });
    completed.and.returnValue(true);
    expect(destination(await enter())).toBe('/auth');
    expect(await enter(guest)).toBeTrue();
  });

  it('restores a native session before skipping the welcome and auth', async () => {
    nativePlatform.and.returnValue(true);
    restoreSession.and.resolveTo(true);
    for (const guard of [landingGuest, guest, welcomeGuest]) {
      expect(destination(await enter(guard))).toBe('/app/chats');
    }
  });

  it('restores an Electron session before skipping the welcome', async () => {
    Object.defineProperty(window, 'nivraSecureVault', { configurable: true, value: {} });
    restoreSession.and.resolveTo(true);
    expect(destination(await enter())).toBe('/app/chats');
    expect(destination(await enter(welcomeGuest))).toBe('/app/chats');
  });

  it('sends a first native auth request through the welcome without looping', async () => {
    nativePlatform.and.returnValue(true);
    expect(destination(await enter(guest))).toBe('/welcome');
    expect(await enter(welcomeGuest)).toBeTrue();
    completed.and.returnValue(true);
    expect(await enter(guest)).toBeTrue();
  });

  it('keeps browser auth direct and does not expose the app welcome', async () => {
    expect(await enter(guest)).toBeTrue();
    expect(destination(await enter(welcomeGuest))).toBe('/auth');
  });

  it('does not erase pending invitations while routing a native guest through the welcome', async () => {
    nativePlatform.and.returnValue(true);
    const removeStoredValue = spyOn(Storage.prototype, 'removeItem');
    expect(destination(await enter(guest))).toBe('/welcome');
    expect(await enter(welcomeGuest)).toBeTrue();
    expect(removeStoredValue).not.toHaveBeenCalled();
  });
});
