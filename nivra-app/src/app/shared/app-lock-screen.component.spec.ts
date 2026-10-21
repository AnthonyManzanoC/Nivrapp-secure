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
    busy: ReturnType<typeof signal<boolean>>;
    lockCycle: ReturnType<typeof signal<number>>;
    pinRetrySeconds: ReturnType<typeof signal<number>>;
    unlockError: ReturnType<typeof signal<string>>;
    unlockMode: ReturnType<typeof signal<'pin' | 'biometric'>>;
    biometryLabel: ReturnType<typeof signal<string>>;
    normalizePin: (value: string) => string;
    unlockWithPin: jasmine.Spy;
    unlockWithBiometrics: jasmine.Spy;
  };

  beforeEach(async () => {
    appLock = {
      isLocked: signal(true), busy: signal(false), lockCycle: signal(1), pinRetrySeconds: signal(0),
      unlockError: signal(''), unlockMode: signal<'pin' | 'biometric'>('pin'), biometryLabel: signal('huella digital'),
      normalizePin: value => value.replace(/\D/g, '').slice(0, 4),
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
});
