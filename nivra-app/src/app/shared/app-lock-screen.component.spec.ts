import { signal } from '@angular/core';
import { ComponentFixture, TestBed, fakeAsync, flushMicrotasks } from '@angular/core/testing';
import { AppLockScreenComponent } from './app-lock-screen.component';
import { AppLockService } from '../core/services/app-lock.service';
import { TranslateService } from '../core/services/translate.service';

describe('AppLockScreenComponent private entry and keyboard access', () => {
  let fixture: ComponentFixture<AppLockScreenComponent>;
  let component: AppLockScreenComponent;
  let outside: HTMLButtonElement;
  let appLock: {
    isLocked: ReturnType<typeof signal<boolean>>;
    isContentLocked: () => boolean;
    policyPending: ReturnType<typeof signal<boolean>>;
    policySyncing: ReturnType<typeof signal<boolean>>;
    policySyncError: ReturnType<typeof signal<string>>;
    retryPolicySync: jasmine.Spy;
    busy: ReturnType<typeof signal<boolean>>;
    lockCycle: ReturnType<typeof signal<number>>;
    pinRetrySeconds: ReturnType<typeof signal<number>>;
    unlockError: ReturnType<typeof signal<string>>;
    unlockMode: ReturnType<typeof signal<'pin' | 'biometric'>>;
    biometryLabel: ReturnType<typeof signal<string>>;
    hasPinFallback: ReturnType<typeof signal<boolean>>;
    canUseBiometric: ReturnType<typeof signal<boolean>>;
    normalizePin: (value: string) => string;
    usePin: jasmine.Spy;
    useBiometrics: jasmine.Spy;
    unlockWithPin: jasmine.Spy;
    unlockWithBiometrics: jasmine.Spy;
  };

  beforeEach(async () => {
    appLock = {
      isLocked: signal(true), busy: signal(false), lockCycle: signal(1), pinRetrySeconds: signal(0),
      isContentLocked: () => appLock.isLocked() || appLock.policyPending(),
      policyPending: signal(false), policySyncing: signal(false), policySyncError: signal(''), retryPolicySync: jasmine.createSpy(),
      unlockError: signal(''), unlockMode: signal<'pin' | 'biometric'>('pin'), biometryLabel: signal('huella digital'),
      hasPinFallback: signal(false), canUseBiometric: signal(false),
      normalizePin: value => value.replace(/\D/g, '').slice(0, 4),
      usePin: jasmine.createSpy().and.callFake(() => { appLock.unlockMode.set('pin'); appLock.lockCycle.update(value => value + 1); }),
      useBiometrics: jasmine.createSpy().and.callFake(() => { appLock.unlockMode.set('biometric'); appLock.lockCycle.update(value => value + 1); }),
      unlockWithPin: jasmine.createSpy().and.resolveTo(false),
      unlockWithBiometrics: jasmine.createSpy().and.resolveTo(false),
    };
    outside = document.createElement('button');
    outside.textContent = 'Previous action';
    document.body.appendChild(outside);
    outside.focus();
    await TestBed.configureTestingModule({
      imports: [AppLockScreenComponent],
      providers: [
        { provide: AppLockService, useValue: appLock },
        { provide: TranslateService, useValue: { instant: (key: string, fallback: string) => fallback || key } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AppLockScreenComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    outside.remove();
    TestBed.resetTestingModule();
  });

  it('covers unknown account protection without accepting a PIN or exposing chat actions', () => {
    appLock.isLocked.set(false); appLock.policyPending.set(true); appLock.policySyncError.set('Sin conexión.'); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Comprobando la protección');
    expect(fixture.nativeElement.querySelector('.keypad')).toBeNull();
    const retry = fixture.nativeElement.querySelector('.biometric-unlock') as HTMLButtonElement;
    retry.click(); expect(appLock.retryPolicySync).toHaveBeenCalledTimes(1);
    expect(appLock.unlockWithPin).not.toHaveBeenCalled(); expect(appLock.unlockWithBiometrics).not.toHaveBeenCalled();
  });

  it('provides a named modal, places focus on it, and labels the delete key', () => {
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).toBe('nivra-lock-title');
    expect(document.activeElement).toBe(dialog);
    expect(fixture.nativeElement.querySelector('.icon-key').getAttribute('aria-label')).toBe('Borrar último dígito');
    expect(fixture.nativeElement.querySelectorAll('.pin-dots span').length).toBe(4);
  });

  it('accepts keyboard digits and deletion without storing typed digits in the DOM', () => {
    component.handleKeydown(new KeyboardEvent('keydown', { key: '7', cancelable: true }));
    component.handleKeydown(new KeyboardEvent('keydown', { key: '8', cancelable: true }));
    component.handleKeydown(new KeyboardEvent('keydown', { key: '9', repeat: true }));
    component.handleKeydown(new KeyboardEvent('keydown', { key: '1', ctrlKey: true }));
    expect(component.pin()).toBe('78');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.pin-dots .filled').length).toBe(2);
    expect(fixture.nativeElement.textContent).not.toContain('78');
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Backspace', cancelable: true }));
    expect(component.pin()).toBe('7');
  });

  it('submits one complete PIN, rejects extra clicks, and clears the entry when verification returns', fakeAsync(() => {
    let finish!: (valid: boolean) => void;
    appLock.unlockWithPin.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    ['1', '2', '3', '4', '5'].forEach(key => component.pressKey(key));
    expect(appLock.unlockWithPin).toHaveBeenCalledOnceWith('1234');
    expect(component.pin()).toBe('1234');
    finish(false);
    flushMicrotasks();
    expect(component.pin()).toBe('');
    component.pressKey('5');
    flushMicrotasks();
    expect(component.pin()).toBe('5');
  }));

  it('clears successful entries and partial entries across close, relock, or account changes', fakeAsync(() => {
    appLock.unlockWithPin.and.callFake(async () => { appLock.isLocked.set(false); return true; });
    ['1', '2', '3', '4'].forEach(key => component.pressKey(key));
    flushMicrotasks();
    fixture.detectChanges();
    expect(component.pin()).toBe('');
    appLock.isLocked.set(true);
    appLock.lockCycle.update(value => value + 1);
    fixture.detectChanges();
    component.pressKey('7');
    component.pressKey('8');
    appLock.lockCycle.update(value => value + 1);
    fixture.detectChanges();
    expect(component.pin()).toBe('');
  }));

  it('keeps Tab inside the lock and returns focus to the previous action after unlocking', fakeAsync(() => {
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.key')) as HTMLButtonElement[];
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    first.focus();
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
    expect(document.activeElement).toBe(last);
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(first);
    appLock.isLocked.set(false);
    fixture.detectChanges();
    flushMicrotasks();
    expect(document.activeElement).toBe(outside);
  }));

  it('disables both pointer and keyboard entry while waiting or verifying', () => {
    appLock.pinRetrySeconds.set(29);
    fixture.detectChanges();
    component.pressKey('1');
    component.handleKeydown(new KeyboardEvent('keydown', { key: '2' }));
    expect(component.pin()).toBe('');
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('.key')) as HTMLButtonElement[];
    expect(buttons.every(button => button.disabled)).toBeTrue();
    expect(fixture.nativeElement.querySelector('.lock-feedback').textContent).toContain('29 s');
    const dialog = fixture.nativeElement.querySelector('[role="dialog"]') as HTMLElement;
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(dialog);
    appLock.pinRetrySeconds.set(0);
    appLock.busy.set(true);
    component.pressKey('1');
    expect(component.pin()).toBe('');
  });

  it('shows a single biometric action and never accepts keypad digits in biometric mode', async () => {
    appLock.unlockMode.set('biometric');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.keypad')).toBeNull();
    component.pressKey('1');
    expect(component.pin()).toBe('');
    await component.unlockMobile();
    expect(appLock.unlockWithBiometrics).toHaveBeenCalledTimes(1);
    appLock.busy.set(true);
    await component.unlockMobile();
    expect(appLock.unlockWithBiometrics).toHaveBeenCalledTimes(1);
  });

  it('offers the account PIN only when it exists and keeps Nivra locked when selecting it', () => {
    appLock.unlockMode.set('biometric');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pin-fallback')).toBeNull();
    component.usePin();
    expect(appLock.usePin).not.toHaveBeenCalled();
    appLock.hasPinFallback.set(true);
    fixture.detectChanges();
    const fallback = fixture.nativeElement.querySelector('.pin-fallback') as HTMLButtonElement;
    expect(fallback.textContent).toContain('Usar PIN de la cuenta');
    fallback.click();
    fixture.detectChanges();
    expect(appLock.usePin).toHaveBeenCalledTimes(1);
    expect(appLock.isLocked()).toBeTrue();
    expect(fixture.nativeElement.querySelector('.keypad')).not.toBeNull();
    expect(appLock.unlockWithPin).not.toHaveBeenCalled();
    expect(appLock.unlockWithBiometrics).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(fixture.nativeElement.querySelector('[role="dialog"]'));
  });

  it('offers enrolled platform verification, clears a partial PIN, and waits for explicit verification', async () => {
    expect(fixture.nativeElement.querySelector('.platform-fallback')).toBeNull();
    component.useBiometrics();
    expect(appLock.useBiometrics).not.toHaveBeenCalled();
    appLock.canUseBiometric.set(true);
    appLock.biometryLabel.set('Verificación del dispositivo');
    fixture.detectChanges();
    component.pressKey('4');
    component.pressKey('2');
    const fallback = fixture.nativeElement.querySelector('.platform-fallback') as HTMLButtonElement;
    expect(fallback.textContent).toContain('Usar Verificación del dispositivo');
    fallback.click();
    fixture.detectChanges();
    expect(component.pin()).toBe('');
    expect(appLock.isLocked()).toBeTrue();
    expect(appLock.useBiometrics).toHaveBeenCalledTimes(1);
    expect(appLock.unlockWithBiometrics).not.toHaveBeenCalled();
    await component.unlockMobile();
    expect(appLock.unlockWithBiometrics).toHaveBeenCalledTimes(1);
    expect(appLock.isLocked()).toBeTrue();
  });

  it('uses the platform label and a neutral icon for device verification on the web', () => {
    appLock.unlockMode.set('biometric');
    appLock.biometryLabel.set('Verificación del dispositivo');
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.biometric-unlock') as HTMLButtonElement;
    expect(button.textContent).toContain('Verificación del dispositivo');
    expect((button.querySelector('ion-icon') as any)?.name).toBe('shield-checkmark-outline');
    expect(button.textContent).not.toMatch(/huella|biometría/i);
  });

  it('keeps generic native biometry neutral and chooses specific icons only for explicit labels', () => {
    appLock.unlockMode.set('biometric');
    appLock.biometryLabel.set('Biometría del dispositivo');
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('.biometric-unlock') as HTMLButtonElement;
    expect(button.textContent).toContain('Biometría del dispositivo');
    expect((button.querySelector('ion-icon') as any)?.name).toBe('shield-checkmark-outline');
    appLock.biometryLabel.set('Huella digital');
    fixture.detectChanges();
    expect((button.querySelector('ion-icon') as any)?.name).toBe('finger-print-outline');
    appLock.biometryLabel.set('Reconocimiento facial');
    fixture.detectChanges();
    expect((button.querySelector('ion-icon') as any)?.name).toBe('scan-outline');
  });

  it('disables alternative methods while verification is busy and keeps both method handlers guarded', async () => {
    appLock.hasPinFallback.set(true);
    appLock.canUseBiometric.set(true);
    appLock.busy.set(true);
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.platform-fallback') as HTMLButtonElement).disabled).toBeTrue();
    component.useBiometrics();
    appLock.unlockMode.set('biometric');
    fixture.detectChanges();
    expect((fixture.nativeElement.querySelector('.pin-fallback') as HTMLButtonElement).disabled).toBeTrue();
    expect((fixture.nativeElement.querySelector('.biometric-unlock') as HTMLButtonElement).disabled).toBeTrue();
    component.usePin();
    await component.unlockMobile();
    expect(appLock.usePin).not.toHaveBeenCalled();
    expect(appLock.useBiometrics).not.toHaveBeenCalled();
    expect(appLock.unlockWithBiometrics).not.toHaveBeenCalled();
    expect(appLock.isLocked()).toBeTrue();
  });

  it('clears partial digits when platform availability changes the selected method', () => {
    component.pressKey('8');
    expect(component.pin()).toBe('8');
    appLock.unlockMode.set('biometric');
    fixture.detectChanges();
    expect(component.pin()).toBe('');
    appLock.unlockMode.set('pin');
    fixture.detectChanges();
    expect(component.pin()).toBe('');
    expect(appLock.isLocked()).toBeTrue();
  });

  it('traps Tab across the account PIN alternative and platform verification button', () => {
    appLock.unlockMode.set('biometric');
    appLock.hasPinFallback.set(true);
    fixture.detectChanges();
    const primary = fixture.nativeElement.querySelector('.biometric-unlock') as HTMLButtonElement;
    const alternative = fixture.nativeElement.querySelector('.pin-fallback') as HTMLButtonElement;
    primary.focus();
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
    expect(document.activeElement).toBe(alternative);
    component.handleKeydown(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
    expect(document.activeElement).toBe(primary);
  });

  it('never triggers verification or method changes after the screen has unlocked', async () => {
    appLock.hasPinFallback.set(true);
    appLock.canUseBiometric.set(true);
    appLock.unlockMode.set('biometric');
    appLock.isLocked.set(false);
    component.usePin();
    component.useBiometrics();
    await component.unlockMobile();
    expect(appLock.usePin).not.toHaveBeenCalled();
    expect(appLock.useBiometrics).not.toHaveBeenCalled();
    expect(appLock.unlockWithBiometrics).not.toHaveBeenCalled();
  });
});
