import { HttpErrorResponse, HttpEventType, HttpHandlerFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { TestBed, fakeAsync, tick, flushMicrotasks } from '@angular/core/testing';
import { concat, firstValueFrom, lastValueFrom, NEVER, of, throwError } from 'rxjs';
import { ApiEndpointPool } from '../services/api-endpoint-pool.service';
import { AuthService } from '../services/auth.service';
import { apiFailoverInterceptor } from './api-failover.interceptor';

describe('transport failover request semantics', () => {
  const primary = 'https://primary.test', backup = 'https://backup.test';
  let selected: string, session: any, recover: jasmine.Spy;
  const request = (method = 'GET', path = '/messages') => new HttpRequest(method, primary + path, null);
  const run = (req: HttpRequest<unknown>, handler: HttpHandlerFn) => TestBed.runInInjectionContext(() => firstValueFrom(apiFailoverInterceptor(req, handler)));
  beforeEach(() => {
    selected = primary; session = { user: { id: 'alice' }, device: { id: 'phone' } };
    recover = jasmine.createSpy('recover').and.callFake(async () => { selected = backup; return true; });
    TestBed.configureTestingModule({ providers: [
      { provide: ApiEndpointPool, useValue: { isConfiguredUrl: (url: string) => new URL(url).origin === primary,
        rewrite: (url: string) => selected + new URL(url).pathname, recover } },
      { provide: AuthService, useValue: { session: () => session } },
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
    tick(15001); flushMicrotasks();
    expect(recover).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(2); expect(response).toBeInstanceOf(HttpResponse);
  }));
  it('releases a stalled small mutation without replaying its body', fakeAsync(() => {
    const next = jasmine.createSpy('next').and.returnValue(concat(of({ type: HttpEventType.Sent }), NEVER));
    let failed = false;
    TestBed.runInInjectionContext(() => { void lastValueFrom(apiFailoverInterceptor(request('POST'), next)).catch(() => { failed = true; }); });
    tick(15001); flushMicrotasks();
    expect(failed).toBeTrue(); expect(recover).toHaveBeenCalledTimes(1); expect(next).toHaveBeenCalledTimes(1);
  }));
});
