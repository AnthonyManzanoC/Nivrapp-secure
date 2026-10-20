import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { NativeOnboardingService } from './native-onboarding.service';

describe('NativeOnboardingService', () => {
  beforeEach(() => TestBed.configureTestingModule({}));

  it('starts incomplete on a fresh installation', () => {
    spyOn(Storage.prototype, 'getItem').and.returnValue(null);
    expect(TestBed.inject(NativeOnboardingService).isComplete()).toBeFalse();
  });

  it('remembers completion across app launches', () => {
    const values = new Map<string, string>();
    spyOn(Storage.prototype, 'getItem').and.callFake(key => values.get(key) ?? null);
    const write = spyOn(Storage.prototype, 'setItem').and.callFake((key, value) => { values.set(key, value); });
    TestBed.inject(NativeOnboardingService).complete();
    expect(write).toHaveBeenCalledOnceWith('nivra.nativeOnboarding.v1', 'complete');
    expect(new NativeOnboardingService().isComplete()).toBeTrue();
  });

  it('keeps the Next action usable when storage reads and writes are denied', () => {
    spyOn(Storage.prototype, 'getItem').and.throwError('Storage denied');
    spyOn(Storage.prototype, 'setItem').and.throwError('Storage denied');
    const onboarding = TestBed.inject(NativeOnboardingService);
    expect(onboarding.isComplete()).toBeFalse();
    expect(() => onboarding.complete()).not.toThrow();
    expect(onboarding.isComplete()).toBeTrue();
  });

  it('does not treat an unrelated stored value as completed onboarding', () => {
    spyOn(Storage.prototype, 'getItem').and.returnValue('false');
    expect(TestBed.inject(NativeOnboardingService).isComplete()).toBeFalse();
  });

  it('recognizes Capacitor packages', () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    expect(TestBed.inject(NativeOnboardingService).isPackagedApp()).toBeTrue();
  });
});
