import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { ToastController } from '@ionic/angular/standalone';
import { of, Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { ContactSyncService } from './contact-sync.service';
import { CryptoService } from './crypto.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { PushService } from './push.service';
import { SignalrService } from './signalr.service';

describe('native push registration scope', () => {
  let service: PushService;
  let session: ReturnType<typeof signal<any>>;
  let native: jasmine.SpyObj<NativeDeviceService>;
  let api: { baseUrl: string; get: jasmine.Spy; post: jasmine.Spy };
  const account = (id = 'alice', refreshToken = 'refresh-a') => ({
    user: { id, alias: id }, device: { id: `phone-${id}` },
    tokens: { accessToken: 'access', refreshToken },
  });

  beforeEach(() => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(true);
    session = signal<any>(null);
    native = jasmine.createSpyObj<NativeDeviceService>('NativeDeviceService', ['syncPushRegistration', 'clearPushRegistration']);
    native.syncPushRegistration.and.resolveTo(true);
    native.clearPushRegistration.and.resolveTo();
    api = { baseUrl: 'https://api.example.test', get: jasmine.createSpy().and.returnValue(of({ serverReady: true, fcmReady: false })), post: jasmine.createSpy() };
    TestBed.configureTestingModule({ providers: [
      PushService, { provide: AuthService, useValue: { session, isAuthenticated: () => !!session(), ensureFreshSession: async () => !!session() } },
      { provide: NativeDeviceService, useValue: native }, { provide: NivraApiService, useValue: api },
      { provide: ContactSyncService, useValue: {} }, { provide: CryptoService, useValue: {} },
      { provide: SignalrService, useValue: {} }, { provide: ToastController, useValue: {} },
    ] });
    service = TestBed.inject(PushService);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('does not erase the cold-start native credential before auth restoration', () => {
    TestBed.flushEffects();
    expect(native.clearPushRegistration).not.toHaveBeenCalled();
  });

  it('synchronizes rotated refresh credentials after native listeners are bound', () => {
    (service as any).nativeBound = true;
    session.set(account()); TestBed.flushEffects();
    session.set(account('alice', 'refresh-b')); TestBed.flushEffects();
    expect(native.syncPushRegistration.calls.mostRecent().args[0].refreshToken).toBe('refresh-b');
  });

  it('clears native registration on authenticated logout', () => {
    session.set(account()); TestBed.flushEffects();
    session.set(null); TestBed.flushEffects();
    expect(native.clearPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('does not mistake web push readiness for Android FCM readiness', async () => {
    session.set(account());
    await service.refreshStatus();
    expect(service.serverReady()).toBeFalse();
  });

  it('discards a registration response if the account changed during the request', async () => {
    const response = new Subject<any>();
    api.post.and.returnValue(response);
    session.set(account());
    const registration = (service as any).registerServerToken('token');
    await Promise.resolve(); await Promise.resolve();
    session.set(account('bob'));
    response.next({ id: 'alice-push', serverReady: true, fcmReady: true }); response.complete();
    await registration;
    expect(service.tokenId()).toBeNull();
  });

  it('does not route a delayed push belonging to the previous account', async () => {
    session.set(account('bob'));
    await (service as any).handlePushData({ type: 'incoming_call', recipientUserId: 'alice', recipientDeviceId: 'phone-alice' }, 'native-fcm');
    expect(service.lastMessage()).toBeNull();
  });
});
