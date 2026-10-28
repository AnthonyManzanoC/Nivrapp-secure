import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';

describe('hybrid login preserves device key identity', () => {
  let service: AuthService;
  let post: jasmine.Spy;
  let prepareKeys: jasmine.Spy;
  const keys = { keyBundle: { identityKey: 'test-public-key' } };
  const session = { user: { id: 'account', alias: 'old.alias' }, device: { id: 'device' }, tokens: {} };

  beforeEach(() => {
    post = jasmine.createSpy('post');
    prepareKeys = jasmine.createSpy('prepareKeys').and.resolveTo(keys);
    service = Object.assign(Object.create(AuthService.prototype), {
      api: { post }, busy: signal(false),
      crypto: { prepareDeviceKeys: prepareKeys, createDeviceKeys: jasmine.createSpy().and.resolveTo(keys) },
      deviceProfile: () => Promise.resolve({ hardwareId: 'test-device', name: 'Test browser' }),
      completeAuth: jasmine.createSpy('completeAuth').and.resolveTo(),
    });
  });

  it('resolves an ID with credentials before loading the existing alias keys', async () => {
    post.and.returnValues(of({ alias: 'old.alias', userId: 'account' }), of(session));
    await service.loginWithAlias('123 456 789', 'synthetic-test-password', 'login');
    expect(post.calls.first().args[1].resolveOnly).toBeTrue();
    expect(post.calls.first().args[1].alias).toBe('123456789');
    expect(prepareKeys).toHaveBeenCalledOnceWith('old.alias', false, { alias: 'old.alias', userId: 'account' });
    expect(post.calls.mostRecent().args[1].alias).toBe('@old.alias');
    expect(post.calls.mostRecent().args[1].keyBundle).toBe(keys.keyBundle);
    expect(service.busy()).toBeFalse();
  });

  it('keeps explicit numeric aliases unambiguous without resolving them as IDs', async () => {
    post.and.returnValues(of({ alias: '123456789', userId: 'account' }), of(session));
    await service.loginWithAlias('@123456789', 'synthetic-test-password', 'login');
    expect(prepareKeys).toHaveBeenCalledOnceWith('123456789', false, { alias: '123456789', userId: 'account' });
    expect(post.calls.count()).toBe(2);
    expect(post.calls.first().args[1].alias).toBe('@123456789');
    expect(post.calls.first().args[1].resolveOnly).toBeTrue();
  });

  it('does not generate or replace device keys after rejected ID credentials', async () => {
    post.and.returnValue(throwError(() => ({ status: 401 })));
    await expectAsync(service.loginWithAlias('123456789', 'synthetic-invalid-password', 'login')).toBeRejected();
    expect(prepareKeys).not.toHaveBeenCalled();
    expect(service.busy()).toBeFalse();
  });

  it('uses a fresh isolated identity when an older API resolves only a mutable alias', async () => {
    post.and.returnValues(of({ alias: 'reassigned' }), of(session));
    await service.loginWithAlias('@reassigned', 'synthetic-test-password', 'login');
    expect(prepareKeys).not.toHaveBeenCalled(); expect((service as any).crypto.createDeviceKeys).toHaveBeenCalledTimes(1);
    expect((service as any).completeAuth).toHaveBeenCalledWith(session, keys, jasmine.any(Function));
  });

  it('does not downgrade a supplied but malformed account identifier to legacy alias login', async () => {
    post.and.returnValue(of({ alias: 'reassigned', userId: '' }));
    await expectAsync(service.loginWithAlias('@reassigned', 'synthetic-test-password', 'login')).toBeRejected();
    expect(prepareKeys).not.toHaveBeenCalled(); expect((service as any).crypto.createDeviceKeys).not.toHaveBeenCalled();
  });

  it('rejects an account switch between credential resolution and the login response', async () => {
    post.and.returnValues(of({ alias: 'old.alias', userId: 'account' }), of({ ...session, user: { ...session.user, id: 'other-account' } }));
    await expectAsync(service.loginWithAlias('@old.alias', 'synthetic-test-password', 'login')).toBeRejected();
    expect((service as any).completeAuth).not.toHaveBeenCalled();
  });

  it('creates isolated phone keys before resolving the phone account instead of reusing browser keys', async () => {
    post.and.returnValue(of({ auth: session }));
    await (service as any).completeFirebasePhoneSignIn('+15550000001', 'synthetic-firebase-token');
    expect(prepareKeys).not.toHaveBeenCalled(); expect((service as any).crypto.createDeviceKeys).toHaveBeenCalledTimes(1);
    expect((service as any).completeAuth).toHaveBeenCalledWith(session, keys, jasmine.any(Function));
  });

  it('never persists or navigates a canceled QR import while protected session encryption is pending', async () => {
    let finishKey!: (key: CryptoKey) => void;
    const protector = new Promise<CryptoKey>(resolve => { finishKey = resolve; });
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    let current = true;
    const imported: any = Object.assign(Object.create(AuthService.prototype), {
      session: signal(null), sessionWriteEpoch: 0,
      secureVault: { requiresProtection: () => true },
      accountSessions: { upsert: async (_auth: any, _activate: boolean, guard: () => boolean) => { await protector; return guard() ? {} : null; } },
      allowAccountActivation: async () => true,
      authSessionProtectorKey: () => protector,
      crypto: { materialToDeviceKeys: () => keys, saveDeviceKeys: async () => undefined, b64: () => 'not-persisted' },
      markFreshAuthNavigation: () => undefined,
      router: { navigateByUrl: jasmine.createSpy('navigate') },
    });
    const setItem = spyOn(localStorage, 'setItem');
    const pending = imported.completeImportedAuth(session, { publicJwk: {}, privateJwk: {} }, undefined, () => current);
    await Promise.resolve(); await Promise.resolve();
    current = false; finishKey(key); await pending;
    expect(setItem).not.toHaveBeenCalled(); expect(imported.session()).toBeNull(); expect(imported.router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('does not merge a previous account refresh response into the current account', async () => {
    const a = { user: { id: 'alice' }, device: { id: 'alice-device' }, tokens: { accessToken: 'alice-access', refreshToken: 'alice-refresh' } };
    const b = { user: { id: 'bob' }, device: { id: 'bob-device' }, tokens: { accessToken: 'bob-access', refreshToken: 'bob-refresh' } };
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => { finish = resolve; });
    spyOn(window, 'fetch').and.returnValue(response);
    const refreshing: any = Object.assign(Object.create(AuthService.prototype), {
      session: signal<any>(a), sessionWriteEpoch: 0, authRefreshPromise: null, refreshBackoffUntil: 0,
      restoreProtectedSession: async () => undefined, api: { fetch: (_path: string, init: RequestInit) => window.fetch('/synthetic-refresh', init) },
      persistSession: jasmine.createSpy('persist'),
    });
    const pending = refreshing.refreshToken(); await Promise.resolve();
    refreshing.session.set(b);
    finish(new Response(JSON.stringify({ accessToken: 'refreshed-alice', refreshToken: 'next-alice' }), { status: 200 }));
    expect(await pending).toBeFalse(); expect(refreshing.session()).toBe(b); expect(refreshing.persistSession).not.toHaveBeenCalled();
  });

  it('cannot restore a protected session after logout or a different login finishes during decryption', async () => {
    const old = { user: { id: 'alice' }, device: { id: 'alice-device' }, tokens: { accessToken: 'alice-access', refreshToken: 'alice-refresh' } };
    const current = { user: { id: 'bob' }, device: { id: 'bob-device' }, tokens: { accessToken: 'bob-access', refreshToken: 'bob-refresh' } };
    for (const next of [null, current]) {
      let finish!: (value: unknown) => void;
      const decrypted = new Promise(resolve => { finish = resolve; });
      const restoring: any = Object.assign(Object.create(AuthService.prototype), {
        session: signal<any>(null), sessionWriteEpoch: 0, protectedSessionRestorePromise: null,
        secureVault: { requiresProtection: () => true }, readProtectedSessionEnvelope: () => ({}),
        accountSessions: { load: async () => null },
        decryptProtectedSession: () => decrypted,
      });
      const pending = restoring.restoreProtectedSession();
      restoring.sessionWriteEpoch++; restoring.session.set(next); finish(old); await pending;
      expect(restoring.session()).toBe(next);
    }
  });

  it('keeps the QR destination identity local while accepting historical material from an older source', async () => {
    const local = { publicJwk: { kty: 'EC', crv: 'P-256', x: 'local-x', y: 'local-y' }, privateJwk: { d: 'local-private' }, keyBundle: { identityKey: 'local' } };
    const source = { publicJwk: { kty: 'EC', crv: 'P-256', x: 'source-x', y: 'source-y' }, privateJwk: { d: 'source-private' } };
    const auth = { user: { id: 'alice', alias: 'alice' }, device: { id: 'target' }, tokens: { accessToken: 'target-token', refreshToken: 'target-refresh' } };
    const linked: any = Object.assign(Object.create(AuthService.prototype), {
      api: { fetch: (_path: string, init: RequestInit) => window.fetch('/synthetic-keys', init) }, crypto: { parsePublicJwk: JSON.parse, samePublicKey: (a: any, b: any) => a.x === b?.x && a.y === b?.y },
      completeImportedAuth: jasmine.createSpy('complete').and.resolveTo(),
    });
    spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify([{ userId: 'alice', devices: [{ deviceId: 'target', keyBundle: { identityKey: JSON.stringify(local.publicJwk) } }] }]), { status: 200 }));
    const current = () => true;
    const payload = { keyMaterial: source };
    await linked.completeLocalQrAuth(auth, payload, local, current);
    expect(linked.completeImportedAuth).toHaveBeenCalledOnceWith(auth, local, [source], current, payload);
  });

  it('rejects a server QR identity mismatch or cancellation without importing or replacing the source key', async () => {
    const local = { publicJwk: { x: 'local', y: 'local' }, privateJwk: { d: 'local-private' } };
    const source = { publicJwk: { x: 'source', y: 'source' }, privateJwk: { d: 'source-private' } };
    const auth = { user: { id: 'alice' }, device: { id: 'target' }, tokens: { accessToken: 'target-token', refreshToken: 'target-refresh' } };
    const linked: any = Object.assign(Object.create(AuthService.prototype), {
      api: { fetch: (_path: string, init: RequestInit) => window.fetch('/synthetic-keys', init) }, crypto: { parsePublicJwk: (value: string) => value ? JSON.parse(value) : null, samePublicKey: (a: any, b: any) => a.x === b?.x && a.y === b?.y },
      completeImportedAuth: jasmine.createSpy('complete').and.resolveTo(),
    });
    let current = true;
    const request = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify([{ userId: 'alice', devices: [{ deviceId: 'target', keyBundle: { identityKey: JSON.stringify(source.publicJwk) } }] }]), { status: 200 }));
    await expectAsync(linked.completeLocalQrAuth(auth, { userId: 'alice', keyMaterial: source }, local, () => current)).toBeRejected();
    request.and.callFake(async () => { current = false; return new Response('{}'); });
    await linked.completeLocalQrAuth(auth, { userId: 'alice', keyMaterial: source }, local, () => current);
    expect(linked.completeImportedAuth).not.toHaveBeenCalled();
  });

  it('creates a private account without a supplied alias, phone or email and rejects a short PIN', async () => {
    post.and.returnValue(of(session));
    await expectAsync(service.createPrivateAccount('1234')).toBeRejected();
    expect(post).not.toHaveBeenCalled();
    await service.createPrivateAccount('synthetic-test-password');
    expect(post.calls.first().args[0]).toBe('/auth/register-private');
    const payload = post.calls.first().args[1];
    expect(payload.alias).toBeUndefined();
    expect(payload.phone).toBeUndefined();
    expect(payload.email).toBeUndefined();
  });
});

describe('approved QR contact continuity handoff',()=>{
  const auth={user:{id:'owner',alias:'owner'},device:{id:'phone'},tokens:{accessToken:'fixture-token'}};
  const continuity={v:1,purpose:'identity-continuity',userId:'owner',sourceDeviceId:'phone',entries:[]};
  function sourceHarness(){
    const encrypt=jasmine.createSpy('seal').and.resolveTo('encrypted-fixture');
    const post=jasmine.createSpy('post').and.returnValue(of({}));
    const exporter=jasmine.createSpy('export').and.resolveTo(continuity);
    const service:any=Object.assign(Object.create(AuthService.prototype),{
      session:signal<any>(auth),parseQrLoginChallenge:()=>({qrId:'qr',code:'code',publicSpki:'fixture-public-key'}),
      crypto:{currentKeyMaterial:async()=>({privateJwk:{},publicJwk:{}}),exportDeviceKeyMaterialsForUser:async()=>[],encryptQrPayload:encrypt},
      identityTrust:{exportForLinkedDevice:exporter},deviceProfile:async()=>({name:'phone',hardwareId:'fixture-hardware'}),api:{post},
    });
    return {service,encrypt,post,exporter};
  }
  it('seals only the approved current owner namespace alongside the QR key history',async()=>{
    const {service,encrypt,post,exporter}=sourceHarness();await service.authorizeQrLoginText('fixture-qr');
    expect(exporter).toHaveBeenCalledOnceWith('owner','phone');
    expect(encrypt.calls.first().args[1].identityTrust).toBe(continuity);
    expect(encrypt.calls.first().args[1].sourceDeviceId).toBe('phone');
    expect(post.calls.first().args[1]).toEqual({qrId:'qr',code:'code',encryptedPayload:'encrypted-fixture'});
  });
  it('does not authorize the former account after a delayed continuity export',async()=>{
    const {service,encrypt,post,exporter}=sourceHarness();
    exporter.and.callFake(async()=>{service.session.set({...auth,user:{id:'other',alias:'other'}});return continuity;});
    await expectAsync(service.authorizeQrLoginText('fixture-qr')).toBeRejectedWithError(/sesión cambió/);
    expect(encrypt).not.toHaveBeenCalled();expect(post).not.toHaveBeenCalled();
  });
  it('keeps QR linking functional when optional local continuity metadata is unavailable',async()=>{
    const {service,encrypt,post,exporter}=sourceHarness();exporter.and.rejectWith(new Error('fixture unavailable'));
    await service.authorizeQrLoginText('fixture-qr');
    expect(encrypt.calls.first().args[1].identityTrust).toBeUndefined();expect(post).toHaveBeenCalledTimes(1);
  });
  function targetHarness(){
    const imported=jasmine.createSpy('import').and.resolveTo(1);const persist=jasmine.createSpy('persist').and.resolveTo(true);
    const service:any=Object.assign(Object.create(AuthService.prototype),{
      allowAccountActivation:async()=>true,crypto:{materialToDeviceKeys:(key:unknown)=>key,saveDeviceKeys:async()=>undefined},
      identityTrust:{importFromLinkedDevice:imported},persistSession:persist,addingAccount:signal(false),markFreshAuthNavigation:()=>undefined,
      consumePostAuthUrl:()=>'/app/chats',router:{navigateByUrl:jasmine.createSpy('navigate').and.resolveTo(true)},
    });
    return {service,imported,persist};
  }
  it('restores optional continuity before activating the destination account',async()=>{
    const {service,imported,persist}=targetHarness();const current=()=>true;const target={...auth,device:{id:'laptop'}};
    imported.and.callFake(async()=>{expect(persist).not.toHaveBeenCalled();return 1;});
    await service.completeImportedAuth(target,{publicJwk:{},privateJwk:{}},undefined,current,{identityTrust:continuity,sourceDeviceId:'phone'});
    expect(imported).toHaveBeenCalledOnceWith(JSON.stringify(['owner','laptop']),'phone',continuity,current);expect(persist).toHaveBeenCalledOnceWith(target,current);
  });
  it('does not activate a canceled destination after the optional metadata import returns',async()=>{
    const {service,imported,persist}=targetHarness();let current=true;
    imported.and.callFake(async()=>{current=false;return 0;});
    await service.completeImportedAuth(auth,{publicJwk:{},privateJwk:{}},undefined,()=>current,{identityTrust:continuity,sourceDeviceId:'phone'});
    expect(persist).not.toHaveBeenCalled();expect(service.router.navigateByUrl).not.toHaveBeenCalled();
  });
});
