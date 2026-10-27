import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { ToastController } from '@ionic/angular/standalone';
import { of, Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { CallsService } from './calls.service';
import { ContactSyncService } from './contact-sync.service';
import { CryptoService } from './crypto.service';
import { DeviceWipeService } from './device-wipe.service';
import { DesktopInactivePushService } from './desktop-inactive-push.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { PushService } from './push.service';
import { SignalrService } from './signalr.service';

describe('saved account push registration and routing', () => {
  let service: PushService; let session: ReturnType<typeof signal<any>>;
  let credentials: ReturnType<typeof signal<any[]>>; let generation: ReturnType<typeof signal<number>>;
  let native: jasmine.SpyObj<NativeDeviceService>; let switchAccount: jasmine.Spy;
  let api: { baseUrl: string; get: jasmine.Spy; post: jasmine.Spy };
  let calls: { activeCall: jasmine.Spy; resumableCall: jasmine.Spy; handleNotificationCallAction: jasmine.Spy };
  const account = (id = 'alice', refreshToken = 'refresh-a') => ({
    user: { id, alias: id }, device: { id: `phone-${id}` }, tokens: { accessToken: 'access', refreshToken },
  });
  const flush = async () => { TestBed.flushEffects(); await (service as any).scopeSync; };

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    session = signal<any>(null); credentials = signal<any[]>([]); generation = signal(0);
    native = jasmine.createSpyObj<NativeDeviceService>('NativeDeviceService', [
      'syncPushRegistrations', 'clearPushRegistration', 'pendingPushIntent', 'clearPendingPushIntent', 'addPushIntentListener', 'clearIncomingCall',
    ]);
    native.syncPushRegistrations.and.resolveTo(); native.clearPushRegistration.and.resolveTo();
    native.pendingPushIntent.and.resolveTo(null); native.clearPendingPushIntent.and.resolveTo(); native.addPushIntentListener.and.resolveTo(null);
    native.clearIncomingCall.and.resolveTo();
    api = { baseUrl: 'https://api.example.test', get: jasmine.createSpy().and.returnValue(of({ serverReady: true, fcmReady: false })), post: jasmine.createSpy() };
    switchAccount = jasmine.createSpy('switchToStoredAccount').and.callFake(async (userId, deviceId) => {
      const saved = credentials().find(item => item.user.id === userId && item.device.id === deviceId);
      if (!saved) return false;
      session.set(saved); generation.update(value => value + 1); return true;
    });
    calls = { activeCall: jasmine.createSpy().and.returnValue(null), resumableCall: jasmine.createSpy().and.returnValue(null), handleNotificationCallAction: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [
      PushService, { provide: AuthService, useValue: { session, sessionGeneration: generation,
        savedAccounts: computed(() => credentials().map(item => ({ id: item.user.id }))),
        storedSessionCredentials: async () => structuredClone(credentials()), switchToStoredAccount: switchAccount,
        isAuthenticated: () => !!session(), ensureFreshSession: async () => !!session() } },
      { provide: NativeDeviceService, useValue: native }, { provide: NivraApiService, useValue: api },
      { provide: ContactSyncService, useValue: {} }, { provide: CryptoService, useValue: {} },
      { provide: CallsService, useValue: calls },
      { provide: DesktopInactivePushService, useValue: { events$: new Subject<Record<string, string>>(), enable: jasmine.createSpy('desktopEnable') } },
      { provide: DeviceWipeService, useValue: { processPendingAccountWipes: async () => undefined, wipeAccount: jasmine.createSpy().and.resolveTo() } },
      { provide: SignalrService, useValue: { connected: () => true } }, { provide: ToastController, useValue: {} },
    ] });
    service = TestBed.inject(PushService);
  });
  afterEach(() => TestBed.resetTestingModule());

  it('preserves the cold-start credential before the protected registry restores', async () => {
    await flush(); expect(native.syncPushRegistrations).not.toHaveBeenCalled(); expect(native.clearPushRegistration).not.toHaveBeenCalled();
  });

  it('syncs both saved credentials and rotated tokens while keeping the active scope separate', async () => {
    credentials.set([account(), account('bob', 'refresh-bob')]); session.set(account()); await flush();
    let [accounts, active] = native.syncPushRegistrations.calls.mostRecent().args;
    expect(accounts.map(item => item.userId)).toEqual(['alice', 'bob']); expect(active).toEqual({ userId: 'alice', deviceId: 'phone-alice' });
    credentials.set([account('alice', 'rotated-a'), account('bob', 'refresh-bob')]); await flush();
    accounts = native.syncPushRegistrations.calls.mostRecent().args[0];
    expect(accounts[0].refreshToken).toBe('rotated-a'); expect(accounts[1].refreshToken).toBe('refresh-bob');
  });

  it('removing A publishes B membership without clearing the whole native registry', async () => {
    credentials.set([account(), account('bob')]); session.set(account()); await flush();
    credentials.set([account('bob')]); session.set(account('bob')); await flush();
    expect(native.syncPushRegistrations.calls.mostRecent().args[0].map(item => item.userId)).toEqual(['bob']);
    expect(native.clearPushRegistration).not.toHaveBeenCalled();
  });

  it('does not mistake web push readiness for Android FCM readiness', async () => {
    session.set(account()); await service.refreshStatus(); expect(service.serverReady()).toBeFalse();
  });

  it('discards a late token response after A to B to A even if the same tuple is active again', async () => {
    const response = new Subject<any>(); api.post.and.returnValue(response); session.set(account());
    const registration = (service as any).registerServerToken('token'); await Promise.resolve(); await Promise.resolve();
    session.set(account('bob')); generation.update(value => value + 1); session.set(account()); generation.update(value => value + 1);
    response.next({ id: 'obsolete', serverReady: true, fcmReady: true }); response.complete(); await registration;
    expect(service.tokenId()).toBeNull();
  });

  it('shows an inactive account generic receipt without switching or emitting route intent', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    const toast = spyOn<any>(service, 'showForegroundToast').and.resolveTo();
    spyOn<any>(service, 'isAppInteractive').and.returnValue(true);
    await (service as any).handlePushData({ type: 'incoming_call', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', nivraRouteIntent: 'tap', action: 'accept' }, 'native-fcm');
    expect(switchAccount).not.toHaveBeenCalled(); expect(service.lastMessage()).toBeNull(); expect(toast).toHaveBeenCalled();
    const visual = await (service as any).visualForData(toast.calls.first().args[0]);
    expect(visual.title).toBe('Nivra'); expect(visual.body).toBe('Llamada en tu otra cuenta');
  });

  it('adopts the exact callee and native registry before preserving its explicit answer action', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    const order: string[] = [];
    native.syncPushRegistrations.and.callFake(async (_accounts, scope) => { if (scope?.userId === 'alice') order.push('native-alice'); });
    calls.handleNotificationCallAction.and.callFake(async () => { order.push('answer'); });
    await (service as any).handlePushData({ type: 'incoming_call', callId: 'incoming-alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', nivraRouteIntent: 'tap', action: 'accept' }, 'native-action');
    expect(switchAccount).toHaveBeenCalledOnceWith('alice', 'phone-alice');
    expect(service.lastMessage()?.data?.['nivraRouteIntent']).toBe('tap'); expect(service.lastMessage()?.data?.['action']).toBe('accept');
    expect(calls.handleNotificationCallAction).toHaveBeenCalledOnceWith(jasmine.objectContaining({ action: 'answer', callId: 'incoming-alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice' }));
    expect(order.indexOf('native-alice')).toBeLessThan(order.indexOf('answer'));
  });

  it('deduplicates concurrent live and durable native deliveries of the same explicit action', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    const tap = { type: 'incoming_call', callId: 'call-alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', action: 'accept', nivraIntentId: 'native-intent-one' };
    await Promise.all([(service as any).handlePushData(tap, 'native-action'), (service as any).handlePushData(tap, 'native-action')]);
    expect(switchAccount).toHaveBeenCalledTimes(1); expect(calls.handleNotificationCallAction).toHaveBeenCalledTimes(1);
  });

  it('allows the same notification tap to retry after session refresh was temporarily unavailable', async () => {
    credentials.set([account()]); session.set(account());
    const fresh = spyOn(TestBed.inject(AuthService), 'ensureFreshSession').and.resolveTo(false);
    const tap = { type: 'incoming_call', callId: 'call-alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', action: 'accept', nivraIntentId: 'retry-this-intent' };
    await (service as any).handlePushData(tap, 'native-action'); expect(calls.handleNotificationCallAction).not.toHaveBeenCalled();
    fresh.and.resolveTo(true);
    await (service as any).handlePushData(tap, 'native-action'); expect(calls.handleNotificationCallAction).toHaveBeenCalledTimes(1);
  });

  it('does not mistake an outgoing mirror on the caller account for a second incoming call', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    const toast = spyOn<any>(service, 'showForegroundToast').and.resolveTo();
    await (service as any).handlePushData({ type: 'incoming_call', callId: 'call-one', callerUserId: 'alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice' }, 'native-fcm');
    await (service as any).handlePushData({ type: 'incoming_call', callId: 'call-one', callerUserId: 'alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', action: 'accept' }, 'native-action');
    expect(toast).not.toHaveBeenCalled(); expect(switchAccount).not.toHaveBeenCalled(); expect(calls.handleNotificationCallAction).not.toHaveBeenCalled();
  });

  it('allows the callee account to answer when the caller account only has a recovery hint elsewhere', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob')); calls.resumableCall.and.returnValue({ id: 'outgoing-on-laptop' });
    await (service as any).handlePushData({ type: 'incoming_call', callId: 'incoming-alice', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', action: 'decline' }, 'native-action');
    expect(switchAccount).toHaveBeenCalledOnceWith('alice', 'phone-alice');
    expect(calls.handleNotificationCallAction).toHaveBeenCalledOnceWith(jasmine.objectContaining({ action: 'reject', callId: 'incoming-alice' }));
  });

  it('discards a queued action if account generation changes while native adoption is pending', async () => {
    credentials.set([account(), account('bob')]); session.set(account());
    let release!: () => void; native.syncPushRegistrations.and.returnValue(new Promise<void>(resolve => release = resolve));
    const tap = (service as any).handlePushData({ type: 'incoming_call', callId: 'call-one', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', action: 'accept' }, 'native-action');
    for (let i = 0; i < 20; i++) await Promise.resolve();
    session.set(account('bob')); generation.update(value => value + 1); release(); await tap;
    expect(calls.handleNotificationCallAction).not.toHaveBeenCalled(); expect(service.lastMessage()).toBeNull();
  });

  it('does not interrupt an existing call to open the inactive account', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob')); calls.activeCall.and.returnValue({ id: 'ongoing' });
    await (service as any).handlePushData({ type: 'message', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', nivraRouteIntent: 'tap' }, 'native-action');
    expect(switchAccount).not.toHaveBeenCalled(); expect(service.lastMessage()).toBeNull();
  });

  it('rejects an unregistered device even when the same user is saved', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    await (service as any).handlePushData({ type: 'message', recipientUserId: 'alice', recipientDeviceId: 'old-phone', nivraRouteIntent: 'tap' }, 'native-action');
    expect(switchAccount).not.toHaveBeenCalled(); expect(service.lastMessage()).toBeNull();
  });

  it('cancels an inactive terminal call using its own recipient scope', async () => {
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    spyOn<any>(service, 'showForegroundToast').and.resolveTo(); spyOn<any>(service, 'isAppInteractive').and.returnValue(true);
    await (service as any).handlePushData({ type: 'end_call', callId: 'same-call-id', recipientUserId: 'alice', recipientDeviceId: 'phone-alice' }, 'native-fcm');
    expect(native.clearIncomingCall).toHaveBeenCalledOnceWith('same-call-id', { userId: 'alice', deviceId: 'phone-alice' });
    expect(session().user.id).toBe('bob'); expect(service.lastMessage()).toBeNull();
  });

  it('shows a generic desktop notice and switches the exact saved account only after its actual click', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(false);
    credentials.set([account(), account('bob')]); session.set(account('bob'));
    const original = window.Notification; const notices: any[] = [];
    const FakeNotification = class {
      static permission = 'granted'; onclick: (() => void) | undefined; onclose: (() => void) | undefined;
      close = jasmine.createSpy('close');
      constructor(readonly title: string, readonly options: NotificationOptions) { notices.push(this); }
    };
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true, writable: true });
    spyOn(window, 'focus');
    const delivery = spyOn<any>(service, 'handlePushData').and.callThrough();
    try {
      await (service as any).handlePushData({ type: 'message', messageId: 'm-a', recipientUserId: 'alice', recipientDeviceId: 'phone-alice', conversationId: 'chat-a' }, 'desktop-inactive');
      expect(notices.length).toBe(1); expect(notices[0].title).toBe('Nivra'); expect(notices[0].options.body).toBe('Nueva actividad en tu otra cuenta');
      expect(switchAccount).not.toHaveBeenCalled(); expect(service.lastMessage()).toBeNull();
      notices[0].onclick(); await delivery.calls.mostRecent().returnValue;
      expect(switchAccount).toHaveBeenCalledOnceWith('alice', 'phone-alice'); expect(service.lastMessage()?.data?.['nivraRouteIntent']).toBe('tap');
    } finally { Object.defineProperty(window, 'Notification', { value: original, configurable: true, writable: true }); }
  });

  it('discards a decrypted preview when generation or privacy changes during the await', async () => {
    session.set(account());
    let finish!: (value: { title: string; body: string }) => void;
    spyOn<any>(service, 'decryptPreviewIfPresent').and.returnValue(new Promise(resolve => finish = resolve));
    const pending = (service as any).visualForData({ type: 'message', recipientUserId: 'alice', recipientDeviceId: 'phone-alice' });
    session.set(account('bob')); generation.update(value => value + 1);
    session.set({ ...account(), user: { id: 'alice', alias: 'alice', privacySettings: { hideNotificationContent: true } } }); generation.update(value => value + 1);
    finish({ title: 'Secret Name', body: 'Secret Preview' });
    const visual = await pending; expect(visual.title).toBe('Nivra'); expect(visual.body).toBe('Nueva actividad privada');
  });
});
