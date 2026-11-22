import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { PrivacyEnforcementService } from './privacy-enforcement.service';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { NativeDeviceService } from './native-device.service';

describe('Screen privacy across app lock and conversation changes', () => {
  const enabled = signal(false), locked = signal(true);
  const ownCapturePreference = signal<boolean | undefined>(undefined);
  let native: jasmine.Spy, service: PrivacyEnforcementService;
  beforeEach(() => {
    enabled.set(false); locked.set(true);
    ownCapturePreference.set(undefined);
    native = jasmine.createSpy('screen policy').and.resolveTo();
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session: () => ({ user: { id: 'me', privacySettings: { allowScreenshots: ownCapturePreference() } } }) } },
      { provide: AppLockService, useValue: { isEnabled: enabled, isContentLocked: locked } },
      { provide: NativeDeviceService, useValue: { setScreenshotsAllowed: native } },
    ] });
    service = TestBed.inject(PrivacyEnforcementService); TestBed.flushEffects();
  });
  it('protects startup/lock screens and keeps every screen protected while Safe Mode is enabled', () => {
    expect(native).toHaveBeenCalledWith(false);
    locked.set(false); enabled.set(true); TestBed.flushEffects();
    service.clearActiveConversation(); TestBed.flushEffects();
    expect(service.screenshotsAllowed()).toBeFalse();
    enabled.set(false); TestBed.flushEffects(); expect(native.calls.mostRecent().args).toEqual([true]);
    locked.set(true); TestBed.flushEffects(); expect(native.calls.mostRecent().args).toEqual([false]);
  });
  it('continues respecting a remote participant after unlocking and leaving Safe Mode', () => {
    locked.set(false);
    service.setActiveConversation({ id: 'chat', participants: [
      { userId: 'me' }, { userId: 'peer', privacyPolicy: { allowScreenshots: false } },
    ] } as any); TestBed.flushEffects();
    expect(service.screenshotsAllowed()).toBeFalse();
    enabled.set(true); service.clearActiveConversation('chat'); TestBed.flushEffects();
    expect(service.screenshotsAllowed()).toBeFalse();
    enabled.set(false); TestBed.flushEffects(); expect(service.screenshotsAllowed()).toBeTrue();
  });
  it('honors my own capture preference in the chat and does not override a participant who opts out', () => {
    locked.set(false);
    ownCapturePreference.set(false);
    service.setActiveConversation({ id: 'chat', participants: [{ userId: 'me' }, { userId: 'peer' }] } as any);
    TestBed.flushEffects();
    expect(native.calls.mostRecent().args).toEqual([false]);
    ownCapturePreference.set(true);
    TestBed.flushEffects();
    expect(native.calls.mostRecent().args).toEqual([true]);
    service.setActiveConversation({ id: 'chat', participants: [{ userId: 'me' }, { userId: 'peer', privacyPolicy: { allowScreenshots: false } }] } as any);
    TestBed.flushEffects();
    expect(native.calls.mostRecent().args).toEqual([false]);
  });
});
