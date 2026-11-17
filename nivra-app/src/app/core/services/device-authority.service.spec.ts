import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AccountIdentityService } from './account-identity.service';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { DeviceAuthorityService } from './device-authority.service';
import { createAccountIdentity, identityBytes, verifyAccountIdentity } from '../utils/account-identity';

describe('signed device synchronization authority', () => {
  let service: DeviceAuthorityService, session: any, locked: any, api: any, identity: any, secret: any, events: Subject<any>;
  beforeEach(async () => {
    secret = await createAccountIdentity('alice'); session = signal({ user: { id: 'alice' }, device: { id: 'web' } }); locked = signal(false); events = new Subject();
    identity = { state: signal('ready'), exportForDevice: jasmine.createSpy().and.callFake(async () => ({ secret })) };
    api = { post: jasmine.createSpy().and.returnValue(of({ primaryDeviceId: 'web', devices: [] })), get: jasmine.createSpy().and.returnValue(of({ primaryDeviceId: 'apk', devices: [] })) };
    TestBed.configureTestingModule({ providers: [DeviceAuthorityService,
      { provide: AuthService, useValue: { session, sessionGeneration: signal(1) } }, { provide: AppLockService, useValue: { isContentLocked: locked } },
      { provide: AccountIdentityService, useValue: identity }, { provide: NivraApiService, useValue: api }, { provide: SignalrService, useValue: { events$: events } },
    ] });
    service = TestBed.inject(DeviceAuthorityService);
  });
  afterEach(() => TestBed.resetTestingModule());
  async function settle() { TestBed.flushEffects(); await new Promise(resolve => setTimeout(resolve, 20)); }
  it('announces only a signed account-bound platform statement without uploading root secrets', async () => {
    await settle();
    expect(api.post).toHaveBeenCalledTimes(1); const [path, body] = api.post.calls.mostRecent().args;
    expect(path).toBe('/devices/authority/platform'); expect(body.deviceId).toBe('web');
    expect(body.privateJwk).toBeUndefined(); expect(JSON.stringify(body)).not.toContain(secret.recoveryEntropy);
    expect(await verifyAccountIdentity(secret.rootKey, identityBytes(['nivra-device-platform-v1', 'alice', secret.rootKey, 'web', body.platform]), body.signature)).toBeTrue();
    events.next({ type: 'device.listChanged' }); await settle();
    expect(api.post).toHaveBeenCalledTimes(1); expect(api.get).toHaveBeenCalled(); expect(service.authority()?.primaryDeviceId).toBe('apk');
  });
  it('does not announce before root recovery is complete or while content is locked', async () => {
    identity.state.set('recovery'); await settle(); expect(api.post).not.toHaveBeenCalled();
    identity.state.set('ready'); locked.set(true); await settle(); expect(api.post).not.toHaveBeenCalled();
    locked.set(false); await settle(); expect(api.post).toHaveBeenCalledTimes(1);
    locked.set(true); await settle(); expect(service.authority()).toBeNull();
  });
  it('discards delayed root access when another session becomes active', async () => {
    let release!: (value: any) => void;
    identity.exportForDevice.and.returnValue(new Promise(resolve => { release = resolve; }));
    TestBed.flushEffects(); session.set(null); TestBed.flushEffects(); release({ secret }); await settle();
    expect(api.post).not.toHaveBeenCalled(); expect(service.authority()).toBeNull();
  });
  it('keeps older APIs and offline sessions usable when optional hierarchy endpoints are absent', async () => {
    api.post.and.returnValue(throwError(() => ({ status: 404 }))); await settle();
    expect(service.authority()).toBeNull(); expect(api.post).toHaveBeenCalledTimes(1);
    api.post.and.returnValue(of({ primaryDeviceId: 'web', devices: [] })); events.next({ type: 'reconnected' }); await settle();
    expect(service.authority()?.primaryDeviceId).toBe('web');
  });
});
