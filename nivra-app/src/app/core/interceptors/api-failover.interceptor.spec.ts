import { HttpErrorResponse, HttpEventType, HttpHandlerFn, HttpRequest, HttpResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { concat, firstValueFrom, lastValueFrom, NEVER, of, Subject, throwError } from 'rxjs';
import { API_POOL_RUNTIME, ApiEndpointPool } from '../services/api-endpoint-pool.service';
import { AuthService } from '../services/auth.service';
import { ClientCompatibilityService } from '../services/client-compatibility.service';
import { DeviceWipeService } from '../services/device-wipe.service';
import { NivraApiService } from '../services/nivra-api.service';
import { authInterceptor } from './auth.interceptor';
import { apiFailoverInterceptor } from './api-failover.interceptor';
import { NETWORK_POLICY_RUNTIME } from '../services/network-policy.service';

describe('transport failover request semantics', () => {
  const primary = 'https://primary.test', backup = 'https://backup.test';
  let selected: string, session: any, recover: jasmine.Spy;
  const request = (method = 'GET', path = '/messages') => new HttpRequest(method, primary + path, null);
  const run = (req: HttpRequest<unknown>, handler: HttpHandlerFn) => TestBed.runInInjectionContext(() => firstValueFrom(apiFailoverInterceptor(req, handler)));
  beforeEach(() => {
    selected = primary; session = { user: { id: 'alice' }, device: { id: 'phone' } };
    recover = jasmine.createSpy('recover').and.callFake(async () => { selected = backup; return true; });
    TestBed.configureTestingModule({ providers: [
      { provide: ApiEndpointPool, useValue: { prepareForRequest: async () => undefined, reportSuccess: () => undefined, isConfiguredUrl: (url: string) => new URL(url).origin === primary,
        rewrite: (url: string) => selected + new URL(url).pathname, recover } },
      { provide: AuthService, useValue: { session: () => session } },
      { provide: NETWORK_POLICY_RUNTIME, useValue: { hints: () => ({}), onlineHint: () => true, now: () => Date.now(), random: () => .5 } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());
  it('retries a read once after provider suspension', async () => {
    const next = jasmine.createSpy('next').and.callFake((req: HttpRequest<unknown>) => req.url.startsWith(primary)
      ? throwError(() => new HttpErrorResponse({ status: 503 })) : of(new HttpResponse({ body: { ok: true } })));
    await run(request(), next); expect(next).toHaveBeenCalledTimes(2);
    expect(next.calls.mostRecent().args[0].url).toBe(backup + '/messages');
  });
  it('selects a backup for future traffic without duplicating uncertain message sends', async () => {
    const error = new HttpErrorResponse({ status: 0 });
    const next = jasmine.createSpy('next').and.returnValue(throwError(() => error));
    await expectAsync(run(request('POST', '/messages'), next)).toBeRejectedWith(error);
    expect(recover).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
  });
  it('keeps auth errors and user throttles on the same server', async () => {
    for (const status of [401, 403, 429]) await expectAsync(run(request(), () => throwError(() => new HttpErrorResponse({ status })))).toBeRejected();
    expect(recover).not.toHaveBeenCalled();
  });
  it('stops a delayed read retry when the user changes account during recovery', async () => {
    recover.and.callFake(async () => { session = { user: { id: 'bob' }, device: { id: 'other' } }; selected = backup; return true; });
    const next = jasmine.createSpy('next').and.returnValue(throwError(() => new HttpErrorResponse({ status: 0 })));
    await expectAsync(run(request(), next)).toBeRejected(); expect(next).toHaveBeenCalledTimes(1);
  });
  it('times out a stalled read even after the HTTP Sent event and recovers once', fakeAsync(() => {
    const next = jasmine.createSpy('next').and.callFake((req: HttpRequest<unknown>) => req.url.startsWith(primary)
      ? concat(of({ type: HttpEventType.Sent }), NEVER) : of(new HttpResponse({ body: { ok: true } })));
    let response: unknown;
    TestBed.runInInjectionContext(() => { void lastValueFrom(apiFailoverInterceptor(request(), next)).then(value => { response = value; }); });
    tick(30001); flushMicrotasks();
    expect(recover).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(2); expect(response).toBeInstanceOf(HttpResponse);
  }));
  it('releases a stalled small mutation without replaying its body', fakeAsync(() => {
    const next = jasmine.createSpy('next').and.returnValue(concat(of({ type: HttpEventType.Sent }), NEVER));
    let failed = false;
    TestBed.runInInjectionContext(() => { void lastValueFrom(apiFailoverInterceptor(request('POST'), next)).catch(() => { failed = true; }); });
    tick(30001); flushMicrotasks();
    expect(failed).toBeTrue(); expect(recover).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
  }));
  it('lets a slow2G read complete after the old15second deadline without failover', fakeAsync(() => {
    TestBed.overrideProvider(NETWORK_POLICY_RUNTIME, { useValue: { hints: () => ({ effectiveType: '2g' }), onlineHint: () => true, now: () => Date.now(), random: () => .5 } });
    const body = new Subject<HttpResponse<unknown>>();
    let result: unknown;
    const next = jasmine.createSpy('next').and.returnValue(concat(of({ type: HttpEventType.Sent }), body));
    TestBed.runInInjectionContext(() => { void lastValueFrom(apiFailoverInterceptor(request(), next)).then(value => result = value); });
    tick(45000);
    expect(recover).not.toHaveBeenCalled();
    body.next(new HttpResponse({ body: { recovered: true } })); body.complete(); flushMicrotasks();
    expect(result).toBeInstanceOf(HttpResponse);
    expect(next).toHaveBeenCalledTimes(1);
  }));
});

describe('authenticated HTTP chain with a real endpoint pool', () => {
  const primary = 'https://primary.test', backup = 'https://backup.test', pin = 'a'.repeat(64);
  const ready = { status: 'ok', failoverProtocol: 1, apiFailoverReady: true, multiInstanceReady: false, clusterFingerprint: pin,
    callProtocol: 2, minimumCallProtocol: 2, sharedStorageReady: true, realtimeSharedReady: true,
    durableSigningKeyReady: true, push: { fcm: false, webPush: true } };
  let api: NivraApiService, pool: ApiEndpointPool, http: HttpTestingController, probes: jasmine.Spy;
  beforeEach(() => {
    probes = jasmine.createSpy('readiness fetch').and.callFake(async () => new Response(JSON.stringify(ready)));
    TestBed.configureTestingModule({ providers: [
      provideHttpClient(withInterceptors([authInterceptor, apiFailoverInterceptor])), provideHttpClientTesting(),
      { provide: API_POOL_RUNTIME, useValue: { primary, origins: [primary, backup], expectedFingerprint: pin,
        fetch: probes, now: () => 100000, storage: { getItem: () => '', setItem: () => undefined } } },
      { provide: AuthService, useValue: { session: () => ({ user: { id: 'alice' }, device: { id: 'phone' } }),
        sessionGeneration: () => 0,
        accessToken: () => 'synthetic-access', hasFreshAccessToken: () => true,
        refreshToken: jasmine.createSpy('refresh').and.resolveTo(false), lastRefreshFailedPermanently: () => false } },
      { provide: DeviceWipeService, useValue: { nukeDevice: jasmine.createSpy('wipe') } },
      { provide: ClientCompatibilityService, useValue: { requireUpdate: jasmine.createSpy('requireUpdate') } },
    ] });
    api = TestBed.inject(NivraApiService); pool = TestBed.inject(ApiEndpointPool); http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  it('sends the first mutation only to the prepared backup with authentication and protocol headers', async () => {
    probes.and.callFake(async (url: string) => url.startsWith(primary)
      ? new Response('', { status: 503 }) : new Response(JSON.stringify(ready)));
    const result = firstValueFrom(api.post('/messages', { clientMessageId: 'synthetic-message' }));
    await pool.prepare(); await Promise.resolve();
    const sent = http.expectOne(backup + '/messages');
    expect(sent.request.headers.get('Authorization')).toBe('Bearer synthetic-access');
    expect(sent.request.headers.get('X-Nivra-Device-Id')).toBe('phone');
    expect(sent.request.headers.get('X-Nivra-Call-Protocol')).toBe('2');
    http.expectNone(primary + '/messages');
    for (const [, options] of probes.calls.allArgs()) {
      expect(options.credentials).toBe('omit'); expect(options.headers).toBeUndefined();
    }
    sent.flush({ ok: true }); expect(await result).toEqual({ ok: true });
  });
  it('retains the authenticated owner headers when a safe read is replayed on the verified backup', async () => {
    const result = firstValueFrom(api.get('/messages?before=synthetic'));
    await pool.prepare(); await Promise.resolve();
    const first = http.expectOne(primary + '/messages?before=synthetic');
    first.flush({}, { status: 503, statusText: 'Unavailable' });
    await pool.recover(primary + '/messages'); await Promise.resolve();
    const retried = http.expectOne(backup + '/messages?before=synthetic');
    expect(retried.request.headers.get('Authorization')).toBe('Bearer synthetic-access');
    expect(retried.request.headers.get('X-Nivra-Device-Id')).toBe('phone');
    expect(retried.request.headers.get('X-Nivra-Call-Protocol')).toBe('2');
    retried.flush({ ok: true }); expect(await result).toEqual({ ok: true });
  });
});
