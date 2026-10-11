import { HttpErrorResponse, HttpHandlerFn, HttpRequest, HttpHeaders, HttpResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
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
