import { HttpErrorResponse, HttpHandlerFn, HttpRequest, HttpHeaders, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ClientCompatibilityService } from '../services/client-compatibility.service';
import { DeviceWipeService } from '../services/device-wipe.service';
import { NivraApiService } from '../services/nivra-api.service';
import { authInterceptor } from './auth.interceptor';

describe('auth interceptor compatibility handling', () => {
  const api = { baseUrl: 'https://api.nivra.test', isTrustedUrl: (url: string) => new URL(url).origin === 'https://api.nivra.test' };
  const compatibility = { requireUpdate: jasmine.createSpy('requireUpdate') };
  const wipe = { nukeDevice: jasmine.createSpy('nukeDevice') };
  const auth = {
    accessToken: () => 'access-token',
    session: () => ({ device: { id: 'device-1' } }),
    sessionGeneration: () => 0,
    hasFreshAccessToken: () => false,
    ensureFreshSession: jasmine.createSpy('ensureFreshSession').and.resolveTo(true),
    refreshToken: jasmine.createSpy('refreshToken').and.resolveTo(false),
    lastRefreshFailedPermanently: () => false,
    logout: jasmine.createSpy('logout').and.resolveTo(),
  };

  beforeEach(() => {
    compatibility.requireUpdate.calls.reset();
    wipe.nukeDevice.calls.reset();
    auth.ensureFreshSession.calls.reset();
    auth.refreshToken.calls.reset(); auth.refreshToken.and.resolveTo(false);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: NivraApiService, useValue: api },
      { provide: DeviceWipeService, useValue: wipe },
      { provide: ClientCompatibilityService, useValue: compatibility },
    ] });
  });

  it('requires an update when a request sent after session renewal receives HTTP 426', async () => {
    const error = new HttpErrorResponse({ status: 426, statusText: 'Upgrade Required' });
    const next = jasmine.createSpy('next').and.returnValue(throwError(() => error)) as unknown as HttpHandlerFn;
    const request = new HttpRequest('POST', `${api.baseUrl}/calls/start`, {});

    const response = TestBed.runInInjectionContext(() => authInterceptor(request, next));

    await expectAsync(firstValueFrom(response)).toBeRejectedWith(error);
    expect(auth.ensureFreshSession).toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(compatibility.requireUpdate).toHaveBeenCalledTimes(1);
    expect(wipe.nukeDevice).not.toHaveBeenCalled();
  });

  it('never attaches credentials to a host whose name merely starts with the API URL', async () => {
    const next = jasmine.createSpy('next').and.returnValue(of(new HttpResponse({ body: {} }))) as unknown as HttpHandlerFn;
    await TestBed.runInInjectionContext(() => firstValueFrom(authInterceptor(new HttpRequest('GET', `${api.baseUrl}.attacker.test/me`), next)));
    const sent = (next as jasmine.Spy).calls.first().args[0] as HttpRequest<unknown>;
    expect(sent.headers.has('Authorization')).toBeFalse(); expect(sent.headers.has('X-Nivra-Device-Id')).toBeFalse();
  });

  it('ignores a force-wipe instruction from an unrelated HTTP service', async () => {
    const error = new HttpErrorResponse({ status: 403, headers: new HttpHeaders({ 'X-Nivra-Action': 'FORCE_WIPE' }), error: { code: 'FORCE_WIPE' } });
    await expectAsync(TestBed.runInInjectionContext(() => firstValueFrom(authInterceptor(new HttpRequest('GET', 'https://foreign.test/media'), () => throwError(() => error))))).toBeRejected();
    expect(wipe.nukeDevice).not.toHaveBeenCalled();
  });
  it('still applies compatibility rules to the one allowed retry after HTTP 401', async () => {
    auth.refreshToken.and.resolveTo(true);
    const update = new HttpErrorResponse({ status: 426 });
    const next = jasmine.createSpy('next').and.returnValues(throwError(() => new HttpErrorResponse({ status: 401 })), throwError(() => update));
    await expectAsync(TestBed.runInInjectionContext(() => firstValueFrom(authInterceptor(new HttpRequest('GET', `${api.baseUrl}/calls/active`), next)))).toBeRejectedWith(update);
    expect(auth.refreshToken).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(2); expect(compatibility.requireUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('auth interceptor session and response authority', () => {
  const baseUrl = 'https://api.nivra.test';
  let auth: {
    accessToken: jasmine.Spy; session: jasmine.Spy; sessionGeneration: jasmine.Spy; hasFreshAccessToken: jasmine.Spy;
    ensureFreshSession: jasmine.Spy; refreshToken: jasmine.Spy;
    lastRefreshFailedPermanently: jasmine.Spy; logout: jasmine.Spy;
  };
  let compatibility: { requireUpdate: jasmine.Spy };
  let wipe: { nukeDevice: jasmine.Spy };

  beforeEach(() => {
    auth = {
      accessToken: jasmine.createSpy('accessToken').and.returnValue('existing-access'),
      session: jasmine.createSpy('session').and.returnValue({ user: { id: 'owner' }, device: { id: 'device-1' } }),
      sessionGeneration: jasmine.createSpy('sessionGeneration').and.returnValue(0),
      hasFreshAccessToken: jasmine.createSpy('hasFreshAccessToken').and.returnValue(false),
      ensureFreshSession: jasmine.createSpy('ensureFreshSession').and.resolveTo(false),
      refreshToken: jasmine.createSpy('refreshToken').and.resolveTo(false),
      lastRefreshFailedPermanently: jasmine.createSpy('lastRefreshFailedPermanently').and.returnValue(false),
      logout: jasmine.createSpy('logout').and.resolveTo(),
    };
    compatibility = { requireUpdate: jasmine.createSpy('requireUpdate') };
    wipe = { nukeDevice: jasmine.createSpy('nukeDevice') };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth },
      { provide: NivraApiService, useValue: { isTrustedUrl: (value: string) => new URL(value).origin === baseUrl } },
      { provide: DeviceWipeService, useValue: wipe },
      { provide: ClientCompatibilityService, useValue: compatibility },
    ] });
  });

  afterEach(() => TestBed.resetTestingModule());

  const run = (request: HttpRequest<unknown>, next: HttpHandlerFn) => TestBed.runInInjectionContext(() => firstValueFrom(authInterceptor(request, next)));

  it('does not transmit a pending mutation after refresh permanently rejects the session', async () => {
    auth.lastRefreshFailedPermanently.and.returnValue(true);
    const next = jasmine.createSpy('next').and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    let failure: unknown;
    await run(new HttpRequest('POST', `${baseUrl}/messages`, { ciphertext: 'synthetic-message' }), next).catch(error => failure = error);

    expect(failure).toEqual(jasmine.objectContaining({ status: 401 }));
    expect(next).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalledOnceWith(true);
    expect(auth.refreshToken).not.toHaveBeenCalled();
  });

  it('keeps a still usable access token available after a transient refresh failure', async () => {
    const next = jasmine.createSpy('next').and.returnValue(of(new HttpResponse({ body: {} })));
    await run(new HttpRequest('GET', `${baseUrl}/messages`), next);

    expect(next).toHaveBeenCalledTimes(1);
    expect((next.calls.first().args[0] as HttpRequest<unknown>).headers.get('Authorization')).toBe('Bearer existing-access');
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('uses the renewed token once without changing the pending mutation body', async () => {
    auth.ensureFreshSession.and.callFake(async () => { auth.accessToken.and.returnValue('renewed-access'); return true; });
    const body = { ciphertext: 'synthetic-message' };
    const next = jasmine.createSpy('next').and.returnValue(of(new HttpResponse({ body: {} })));
    await run(new HttpRequest('POST', `${baseUrl}/messages`, body), next);

    expect(next).toHaveBeenCalledTimes(1);
    const sent = next.calls.first().args[0] as HttpRequest<unknown>;
    expect(sent.headers.get('Authorization')).toBe('Bearer renewed-access');
    expect(sent.headers.get('X-Nivra-Device-Id')).toBe('device-1');
    expect(sent.body).toBe(body);
  });

  it('ignores security instructions from a final response redirected outside the trusted API', async () => {
    auth.hasFreshAccessToken.and.returnValue(true);
    for (const status of [401, 403, 426]) {
      const error = new HttpErrorResponse({
        status, url: 'https://foreign.test/redirected',
        ...(status === 403 ? {
          headers: new HttpHeaders({ 'X-Nivra-Action': 'FORCE_WIPE' }), error: { code: 'FORCE_WIPE' },
        } : {}),
      });
      await expectAsync(run(new HttpRequest('GET', `${baseUrl}/messages`), () => throwError(() => error))).toBeRejectedWith(error);
    }

    expect(wipe.nukeDevice).not.toHaveBeenCalled();
    expect(compatibility.requireUpdate).not.toHaveBeenCalled();
    expect(auth.refreshToken).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('keeps force-wipe instructions effective for the trusted response origin', async () => {
    auth.hasFreshAccessToken.and.returnValue(true);
    const error = new HttpErrorResponse({ status: 403, url: `${baseUrl}/messages`, error: { code: 'FORCE_WIPE' } });
    await expectAsync(run(new HttpRequest('GET', `${baseUrl}/messages`), () => throwError(() => error))).toBeRejectedWith(error);
    expect(wipe.nukeDevice).toHaveBeenCalledTimes(1);
  });

  it('ignores stale errors after switching away and back to the same user and device', async () => {
    auth.hasFreshAccessToken.and.returnValue(true);
    for (const status of [401, 403, 426]) {
      auth.sessionGeneration.and.returnValue(0);
      const transport = new Subject<HttpResponse<unknown>>();
      const pending = run(new HttpRequest('GET', `${baseUrl}/messages`), () => transport);
      auth.sessionGeneration.and.returnValue(2);
      const error = new HttpErrorResponse({ status, url: `${baseUrl}/messages`, error: { code: 'FORCE_WIPE' } });
      transport.error(error);
      await expectAsync(pending).toBeRejectedWith(error);
    }
    expect(wipe.nukeDevice).not.toHaveBeenCalled();
    expect(compatibility.requireUpdate).not.toHaveBeenCalled();
    expect(auth.refreshToken).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('rejects stale successful responses so subscribers cannot repopulate another account view', async () => {
    auth.hasFreshAccessToken.and.returnValue(true);
    const transport = new Subject<HttpResponse<unknown>>();
    const pending = run(new HttpRequest('GET', `${baseUrl}/me`), () => transport);
    auth.sessionGeneration.and.returnValue(2);
    transport.next(new HttpResponse({ body: { userId: 'owner', secret: 'synthetic-profile' } }));
    await expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
  });

  it('does not retry with new account credentials after an old refresh finishes', async () => {
    auth.hasFreshAccessToken.and.returnValue(true);
    let finish!: (result: boolean) => void;
    auth.refreshToken.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const next = jasmine.createSpy('next').and.returnValue(throwError(() => new HttpErrorResponse({ status: 401 })));
    const pending = run(new HttpRequest('POST', `${baseUrl}/messages`, { body: 'synthetic' }), next);
    auth.sessionGeneration.and.returnValue(2);
    finish(true);
    await expectAsync(pending).toBeRejected();
    expect(next).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
  });
});
