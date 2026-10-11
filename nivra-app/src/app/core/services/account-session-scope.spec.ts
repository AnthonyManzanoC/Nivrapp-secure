import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { AccountService } from './account.service';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('Account request isolation and refresh cost', () => {
  let service: AccountService;
  let session: ReturnType<typeof signal<any>>;
  let api: { get: jasmine.Spy; patch: jasmine.Spy; post: jasmine.Spy };
  let crypto: { currentKeyMaterial: jasmine.Spy; saveDeviceKeys: jasmine.Spy; materialToDeviceKeys: jasmine.Spy };
  let updateUser: jasmine.Spy;
  let requests: Array<{ path: string; response: Subject<any> }>;
  const owner = (id = 'owner-a', device = 'device-a') => ({ user: { id, alias: id, privacySettings: {} }, device: { id: device } });

  beforeEach(() => {
    session = signal<any>(owner());
    requests = [];
    const response = (path: string) => {
      const pending = new Subject<any>();
      requests.push({ path, response: pending });
      return pending;
    };
    api = { get: jasmine.createSpy('get').and.callFake(response), patch: jasmine.createSpy('patch').and.callFake(response), post: jasmine.createSpy('post').and.callFake(response) };
    updateUser = jasmine.createSpy('updateUser').and.callFake((user) => session.set({ ...session(), user }));
    crypto = { currentKeyMaterial: jasmine.createSpy('currentKeyMaterial').and.resolveTo(null), saveDeviceKeys: jasmine.createSpy('saveDeviceKeys').and.resolveTo(), materialToDeviceKeys: jasmine.createSpy('materialToDeviceKeys').and.returnValue({}) };
    TestBed.configureTestingModule({ providers: [
      AccountService,
      { provide: AuthService, useValue: { session, isAuthenticated: () => !!session(), updateUser } },
      { provide: NivraApiService, useValue: api },
      { provide: CryptoService, useValue: crypto },
      { provide: SignalrService, useValue: { events$: new Subject() } },
    ] });
    service = TestBed.inject(AccountService);
    TestBed.flushEffects();
  });

  function completeLoad(start: number, id: string) {
    const values: Record<string, any> = { '/me': owner(id).user, '/devices': [{ id: `device-${id}` }], '/privacy': { marker: id }, '/monetization/entitlements': { marker: id } };
    requests.slice(start, start + 4).forEach(({ path, response }) => response.next(values[path]));
  }

  it('coalesces simultaneous refreshes into one set of four requests', async () => {
    const first = service.load();
    const second = service.load();
    expect(first).toBe(second);
    expect(api.get).toHaveBeenCalledTimes(4);
    completeLoad(0, 'owner-a');
    await first;
    expect(service.loading()).toBeFalse();
    expect(updateUser).toHaveBeenCalledTimes(1);
  });

  it('ignores an old owner refresh and keeps the new request loading until its own completion', async () => {
    const oldRequest = service.load();
    session.set(owner('owner-b', 'device-b'));
    const newRequest = service.load();
    TestBed.flushEffects();
    completeLoad(0, 'owner-a');
    await oldRequest;
    expect(updateUser).not.toHaveBeenCalled();
    expect(service.loading()).toBeTrue();
    expect(service.devices()).toEqual([]);
    completeLoad(4, 'owner-b');
    await newRequest;
    expect(session().user.id).toBe('owner-b');
    expect(service.devices()[0].id).toBe('device-owner-b');
  });

  it('discards a response from an earlier device even for the same account', async () => {
    const pending = service.load();
    session.set(owner('owner-a', 'device-new'));
    TestBed.flushEffects();
    completeLoad(0, 'owner-a');
    await pending;
    expect(updateUser).not.toHaveBeenCalled();
    expect(service.privacy()).toBeNull();
  });

  it('does not apply a late privacy mutation after logout', async () => {
    const pending = service.updatePrivacy({} as any);
    const rejection = expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
    session.set(null);
    TestBed.flushEffects();
    requests[0].response.next({ marker: 'old' });
    await rejection;
    expect(service.privacy()).toBeNull();
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('never sends a profile patch under a different account after asynchronous key lookup', async () => {
    let resolveKeys!: (value: any) => void;
    crypto.currentKeyMaterial.and.returnValue(new Promise((resolve) => resolveKeys = resolve));
    const pending = service.updateProfile({ alias: 'new-alias' });
    const rejection = expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
    session.set(owner('owner-b', 'device-b'));
    resolveKeys({});
    await rejection;
    expect(api.patch).not.toHaveBeenCalled();
    expect(crypto.saveDeviceKeys).not.toHaveBeenCalled();
  });

  it('rejects mismatched profile identities instead of changing the signed-in user', async () => {
    const pending = service.updateProfile({ bio: '' });
    const rejection = expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
    requests[0].response.next(owner('unexpected-owner').user);
    await rejection;
    expect(session().user.id).toBe('owner-a');
    expect(updateUser).not.toHaveBeenCalled();
  });
});
