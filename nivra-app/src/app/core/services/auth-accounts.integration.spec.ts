import { Component } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { deleteDB } from 'idb';
import { firstValueFrom } from 'rxjs';
import { guest } from '../../app.routes';
import { AppComponent } from '../../app.component';
import { AuthPage } from '../../features/auth/auth.page';
import { authInterceptor } from '../interceptors/auth.interceptor';
import type { AuthSession, DeviceKeys } from '../models/nivra.models';
import { ACCOUNT_SESSIONS_DB_NAME, AccountSessionsService } from './account-sessions.service';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { AuthService } from './auth.service';
import { ChatLaunchCacheService } from './chat-launch-cache.service';
import { ClientCompatibilityService } from './client-compatibility.service';
import { CryptoService } from './crypto.service';
import { DeviceWipeService } from './device-wipe.service';
import { NativeOnboardingService } from './native-onboarding.service';
import { NativeSecureVaultService } from './native-secure-vault.service';
import { NivraApiService } from './nivra-api.service';
import { NIVRA_VERSION } from '../release';
import { WEB_LAUNCH_RUNTIME, WebLaunchRuntime, WebLaunchService } from './web-launch.service';

@Component({ standalone: true, template: '<p>Private account route</p>' })
class PrivateAccountRoute {}

/** Real router, auth, interceptor and encrypted IDB registry; only the transport
 * and key persistence are fixtures. No actual account or API is contacted. */
describe('add-account production flow integration', () => {
  const origin = 'https://accounts-fixture.nivra.test';
  const account = (id: string): AuthSession => ({
    user: { id, alias: id, displayName: `Fixture ${id}`, privacySettings: {}, createdAt: '2026-10-26T00:00:00Z' },
    device: { id: `fixture-device-${id}`, userId: id, isTrusted: true, createdAt: '2026-10-26T00:00:00Z' },
    tokens: { accessToken: `fixture-access-${id}`, refreshToken: `fixture-refresh-${id}`,
      accessTokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  } as AuthSession);
  let databaseName: string;
  let registry: AccountSessionsService;
  let auth: AuthService;
  let router: Router;
  let api: NivraApiService;
  let http: HttpTestingController;
  let harness: RouterTestingHarness;
  let authNavigationGate: boolean | Promise<boolean>;
  let webRuntime: WebLaunchRuntime;
  let reload: jasmine.Spy;

  beforeEach(async () => {
    databaseName = `nivra-auth-flow-fixture-${crypto.randomUUID()}`;
    authNavigationGate = true;
    const webStorage = new Map<string, string>();
    reload = jasmine.createSpy('reload');
    webRuntime = {
      isWeb: true, now: () => new Date(), reload,
      storage: { getItem: key => webStorage.get(key) ?? null, setItem: (key, value) => { webStorage.set(key, value); } },
      sensitiveRoute: () => router?.url.startsWith('/auth') ?? false,
      fetchVersion: async () => ({ version: NIVRA_VERSION }),
    };
    TestBed.configureTestingModule({ providers: [
      provideRouter([
        { path: 'auth', canMatch: [guest, () => authNavigationGate], component: AuthPage },
        { path: 'app/chats', component: PrivateAccountRoute },
        { path: 'app/account', component: PrivateAccountRoute },
      ]),
      provideHttpClient(withInterceptors([authInterceptor])), provideHttpClientTesting(),
      { provide: ACCOUNT_SESSIONS_DB_NAME, useValue: databaseName },
      { provide: WEB_LAUNCH_RUNTIME, useValue: webRuntime },
      { provide: NativeSecureVaultService, useValue: { requiresProtection: () => false } },
      { provide: ChatLaunchCacheService, useValue: {} },
      { provide: NativeOnboardingService, useValue: { isPackagedApp: () => true, isComplete: () => true } },
      { provide: DeviceWipeService, useValue: { nukeDevice: jasmine.createSpy('nukeDevice') } },
      { provide: ClientCompatibilityService, useValue: { requireUpdate: jasmine.createSpy('requireUpdate') } },
      { provide: CryptoService, useValue: {
        prepareDeviceKeys: async () => ({ keyBundle: {} } as DeviceKeys),
        saveDeviceKeys: async () => undefined,
      } },
      { provide: ApiEndpointPool, useValue: {
        current: () => origin, clusterFingerprint: () => 'fixture',
        isTrustedUrl: (url: string) => new URL(url).origin === origin,
      } },
    ] });
    registry = TestBed.inject(AccountSessionsService);
    await registry.upsert(account('alice'));
    auth = TestBed.inject(AuthService);
    expect(await auth.ensureSessionRestored()).toBeTrue();
    router = TestBed.inject(Router); api = TestBed.inject(NivraApiService); http = TestBed.inject(HttpTestingController);
    harness = await RouterTestingHarness.create('/app/account');
  }, 30_000);

  afterEach(async () => {
    try { http?.verify(); }
    finally {
      auth?.ngOnDestroy(); registry?.ngOnDestroy();
      await (registry as any)?.database?.then((database: IDBDatabase) => database.close());
      TestBed.resetTestingModule();
    }
    await deleteDB(databaseName);
  }, 30_000);

  async function openAddForm(): Promise<void> {
    await auth.beginAddAccount();
    harness.detectChanges();
    expect(router.url).toBe('/auth');
    expect(auth.addingAccount()).toBeTrue();
    expect(auth.session()).toBeNull();
    expect(harness.routeNativeElement?.textContent).toContain('Añade tu segunda cuenta');
  }

  it('keeps the add form open after a background protected request receives 401 without an active session', async () => {
    await openAddForm();
    const failed = firstValueFrom(api.get('/stories')).catch(error => error);
    const request = http.expectOne(`${origin}/stories`);
    expect(request.request.headers.has('Authorization')).toBeFalse();
    request.flush({}, { status: 401, statusText: 'Unauthorized' });
    await failed;
    // The old failure started async cancelAddAccount() after this response.
    // Let its actual IDB activation and router work finish before asserting.
    await new Promise(resolve => setTimeout(resolve, 50));
    await registry.load(); harness.detectChanges();
    expect(auth.addingAccount()).toBeTrue();
    expect(auth.session()).toBeNull();
    expect(router.url).toBe('/auth');
    expect((await registry.load())?.sessions.map(item => [item.user.id, item.tokens.refreshToken]))
      .toEqual([['alice', 'fixture-refresh-alice']]);
  });

  it('keeps restoration and resume checks from reactivating the saved first slot, then cancels explicitly', async () => {
    await openAddForm();
    expect(await auth.ensureSessionRestored()).toBeFalse();
    expect(await auth.ensureFreshSession()).toBeFalse();
    expect(auth.session()).toBeNull();
    await auth.cancelAddAccount();
    harness.detectChanges();
    expect(auth.session()?.user.id).toBe('alice');
    expect(auth.addingAccount()).toBeFalse();
    expect(router.url).toBe('/app/chats');
  });

  it('never treats automatic expiry without an active account as an explicit cancellation', async () => {
    await openAddForm();
    expect(await auth.refreshToken()).toBeFalse();
    expect(auth.lastRefreshFailedPermanently()).toBeFalse();
    await auth.logout(true);
    harness.detectChanges();
    expect(auth.addingAccount()).toBeTrue();
    expect(auth.session()).toBeNull();
    expect(router.url).toBe('/auth');
    expect((await registry.load())?.sessions.map(item => item.user.id)).toEqual(['alice']);
  });

  it('defers a pending web upgrade before add-account navigation commits and until the user explicitly returns', async () => {
    // Exercise the actual root update guard without instantiating all unrelated
    // application services. Authentication, router and updater below are real.
    const app = Object.assign(Object.create(AppComponent.prototype), {
      auth, calls: { activeCall: () => null, resumableCall: () => null },
      chat: { uploading: () => false, deviceHistory: { approvingRequestId: () => null, state: () => 'idle', pendingRequests: () => [] } },
    });
    const canReload = () => app.canApplyWebUpdate() as boolean;
    let finishVersion!: (value: unknown) => void;
    webRuntime.fetchVersion = () => new Promise(resolve => finishVersion = resolve);
    let finishNavigation!: (value: boolean) => void;
    authNavigationGate = new Promise(resolve => finishNavigation = resolve);
    const updater = TestBed.inject(WebLaunchService);
    const checking = updater.checkForUpdate(canReload);
    expect(canReload()).toBeTrue();

    const adding = auth.beginAddAccount();
    expect(auth.accountsBusy()).toBeTrue();
    expect(auth.addingAccount()).toBeFalse();
    expect(canReload()).toBeFalse();
    for (let step = 0; step < 100 && !auth.addingAccount(); step++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(auth.addingAccount()).toBeTrue();
    expect(router.url).toBe('/app/account');
    finishVersion({ version: `${Number(NIVRA_VERSION.split('.')[0]) + 1}.0.0` });
    await checking;
    expect(reload).not.toHaveBeenCalled();
    expect(auth.session()).toBeNull();

    finishNavigation(true); await adding; harness.detectChanges();
    expect(router.url).toBe('/auth');
    expect(auth.accountsBusy()).toBeFalse();
    expect(canReload()).toBeFalse();
    await auth.cancelAddAccount();
    expect(auth.session()?.user.id).toBe('alice');
    expect(canReload()).toBeTrue();
    await updater.checkForUpdate(canReload);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('authenticates a second fixture through the real form and retains both encrypted slots for switching', async () => {
    await openAddForm();
    const page = harness.routeDebugElement!.componentInstance as AuthPage;
    page.alias = 'bob'; page.password = 'fixture-password';
    const login = page.submitAlias();
    // The device profile is asynchronous even on web; wait for the request.
    await new Promise(resolve => setTimeout(resolve, 0));
    const resolve = http.expectOne(`${origin}/auth/login`);
    expect(resolve.request.body.resolveOnly).toBeTrue();
    expect(resolve.request.headers.has('Authorization')).toBeFalse();
    resolve.flush({ alias: 'bob', userId: 'bob' });
    await new Promise(resolve => setTimeout(resolve, 0));
    const submit = http.expectOne(`${origin}/auth/login`);
    expect(submit.request.body.resolveOnly).toBeUndefined();
    expect(submit.request.headers.has('Authorization')).toBeFalse();
    submit.flush(account('bob'));
    await login; harness.detectChanges();
    expect(auth.session()?.user.id).toBe('bob');
    expect(auth.addingAccount()).toBeFalse();
    expect(router.url).toBe('/app/chats');
    const snapshot = await registry.load();
    expect(snapshot?.sessions.map(item => item.user.id)).toEqual(['alice', 'bob']);
    expect(snapshot?.sessions[0].tokens.refreshToken).toBe('fixture-refresh-alice');
    expect(await auth.switchAccount('alice')).toBeTrue();
    expect(auth.session()?.user.id).toBe('alice');
    expect(await auth.switchAccount('bob')).toBeTrue();
    expect(auth.session()?.user.id).toBe('bob');
  });
});
