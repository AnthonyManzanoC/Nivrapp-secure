import { HttpErrorResponse, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { ClientCompatibilityService } from '../services/client-compatibility.service';
import { DeviceWipeService } from '../services/device-wipe.service';
import { NivraApiService } from '../services/nivra-api.service';
import { authInterceptor } from './auth.interceptor';

describe('auth interceptor compatibility handling', () => {
  const api = { baseUrl: 'https://api.nivra.test' };
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
});
