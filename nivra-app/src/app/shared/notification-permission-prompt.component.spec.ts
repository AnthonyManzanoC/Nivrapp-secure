import { signal } from '@angular/core';
import { ComponentFixture, fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { Subject } from 'rxjs';
import { AuthService } from '../core/services/auth.service';
import { AppLockService } from '../core/services/app-lock.service';
import { CallsService } from '../core/services/calls.service';
import { NativeDeviceService } from '../core/services/native-device.service';
import { PushService } from '../core/services/push.service';
import { NOTIFICATION_PROMPT_RUNTIME } from '../core/services/notification-permission-prompt.service';
import { TranslateService } from '../core/services/translate.service';
import { NotificationPermissionPromptComponent } from './notification-permission-prompt.component';

describe('contextual Android notification permission', () => {
  let fixture: ComponentFixture<NotificationPermissionPromptComponent>;
  let push: any;
  let session: ReturnType<typeof signal<any>>;
  let native: { openNotificationSettings: jasmine.Spy };
  let router: { url: string; events: Subject<any> };
  beforeEach(async () => {
    spyOn(Capacitor, 'getPlatform').and.returnValue('android');
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    session = signal({ user: { id: 'alice' }, device: { id: 'phone' } });
    push = { permission: signal('default'), settingsBlocked: signal(null), refreshPermission: jasmine.createSpy().and.resolveTo('default'),
      requestPermissionAndRegister: jasmine.createSpy().and.resolveTo(false) };
    native = { openNotificationSettings: jasmine.createSpy().and.resolveTo() };
    router = { url: '/app/chats', events: new Subject() };
    let stored: string | null = null;
    await TestBed.configureTestingModule({ imports: [NotificationPermissionPromptComponent], providers: [
      { provide: AuthService, useValue: { session } }, { provide: PushService, useValue: push },
      { provide: AppLockService, useValue: { isContentLocked: () => false } },
      { provide: CallsService, useValue: { activeCall: () => null, resumableCall: () => null } },
      { provide: Router, useValue: router }, { provide: NativeDeviceService, useValue: native },
      { provide: TranslateService, useValue: { currentLanguage: signal('es'), instant: (_key: string, fallback: string) => fallback } },
      { provide: NOTIFICATION_PROMPT_RUNTIME, useValue: { now: () => Date.now(), read: () => stored, write: (value: string) => { stored = value; } } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(NotificationPermissionPromptComponent);
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });

  it('offers one contextual system prompt after Chats is ready and does not loop on focus', fakeAsync(() => {
    fixture.detectChanges();
    tick(1200); flushMicrotasks();
    expect(push.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('focus')); tick(1200); flushMicrotasks();
    expect(push.requestPermissionAndRegister).toHaveBeenCalledTimes(1);
  }));
  it('keeps a denied permission as a settings action without reopening the system request', fakeAsync(() => {
    push.permission.set('denied'); fixture.detectChanges();
    tick(1200); flushMicrotasks();
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    fixture.nativeElement.querySelector('.activate').click(); flushMicrotasks();
    expect(native.openNotificationSettings).toHaveBeenCalledOnceWith('app');
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
  }));
  it('respects Now not even when the delayed automatic check is already queued', fakeAsync(() => {
    fixture.detectChanges();
    fixture.componentInstance.dismiss(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notification-reminder')).toBeNull();
    tick(1200); flushMicrotasks();
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
  }));
  it('waits for the chat list rather than interrupting a conversation or another account', fakeAsync(() => {
    fixture.detectChanges();
    router.url = '/app/chats/conversation'; tick(1200); flushMicrotasks();
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    router.url = '/app/chats';
    let finish!: () => void;
    push.refreshPermission.and.returnValue(new Promise<void>(resolve => finish = resolve));
    window.dispatchEvent(new Event('focus')); tick(1200);
    session.set({ user: { id: 'bob' }, device: { id: 'other-phone' } }); finish(); flushMicrotasks();
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
  }));
  it('explains and opens settings for a disabled message channel even with runtime permission granted', fakeAsync(() => {
    push.permission.set('granted'); push.settingsBlocked.set('messages'); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.notification-reminder')).not.toBeNull();
    fixture.nativeElement.querySelector('.activate').click(); flushMicrotasks();
    expect(native.openNotificationSettings).toHaveBeenCalledOnceWith('app');
    expect(push.requestPermissionAndRegister).not.toHaveBeenCalled();
    tick(1200); flushMicrotasks();
  }));
});
