import { HttpContextToken, HttpErrorResponse, HttpEvent, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { DeviceWipeService } from '../services/device-wipe.service';
import { NivraApiService, SKIP_AUTH } from '../services/nivra-api.service';
import { ClientCompatibilityService } from '../services/client-compatibility.service';
import { NIVRA_CALL_PROTOCOL, NIVRA_VERSION } from '../release';

const AUTH_RETRIED = new HttpContextToken<boolean>(() => false);

export function authInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const auth = inject(AuthService);
  const api = inject(NivraApiService);
  const wipe = inject(DeviceWipeService);
  const compatibility = inject(ClientCompatibilityService);
  const trustedApi = api.isTrustedUrl(req.url);
  if (trustedApi) {
    req = req.clone({ setHeaders: { 'X-Nivra-Call-Protocol': String(NIVRA_CALL_PROTOCOL), 'X-Nivra-Client-Version': NIVRA_VERSION } });
  }
  const shouldAuthenticate = !req.context.get(SKIP_AUTH) && trustedApi;
  const token = auth.accessToken();
  const requestSession = auth.session();
  const deviceId = requestSession?.device.id || '';
  const sameSession = () => auth.session()?.user?.id === requestSession?.user?.id && auth.session()?.device.id === requestSession?.device.id;
  const authHeaders = () => ({
    ...(auth.accessToken() ? { Authorization: `Bearer ${auth.accessToken()}` } : {}),
    ...(deviceId ? { 'X-Nivra-Device-Id': deviceId } : {}),
  });
  const handleError = (error: unknown): Observable<HttpEvent<unknown>> => {
    // A redirect does not transfer API authority to its final response origin.
    if (error instanceof HttpErrorResponse && error.url && !api.isTrustedUrl(error.url)) {
      return throwError(() => error);
    }
    if (trustedApi && sameSession() && error instanceof HttpErrorResponse && error.status === 426) {
      compatibility.requireUpdate();
    }
    if (trustedApi && sameSession() && isForceWipeError(error)) {
      void wipe.nukeDevice();
      return throwError(() => error);
    }

    if (
      error instanceof HttpErrorResponse &&
      error.status === 401 &&
      shouldAuthenticate &&
      sameSession() &&
      !req.context.get(AUTH_RETRIED)
    ) {
      return from(auth.refreshToken()).pipe(
        switchMap((refreshed) => {
          if (!sameSession()) return throwError(() => error);
          if (!refreshed) {
            if (auth.lastRefreshFailedPermanently()) {
              void auth.logout(true);
            }
            return throwError(() => error);
          }
          const retry = req.clone({
            context: req.context.set(AUTH_RETRIED, true),
            setHeaders: authHeaders(),
          });
          return next(retry).pipe(catchError(handleError));
        }),
      );
    }

    return throwError(() => error);
  };
  if (shouldAuthenticate && token && !auth.hasFreshAccessToken()) {
    return from(auth.ensureFreshSession()).pipe(
      switchMap((refreshed) => {
        if (!sameSession()) return throwError(() => new Error('Session changed'));
        if (!refreshed) {
          if (auth.lastRefreshFailedPermanently()) {
            void auth.logout(true);
            return throwError(() => new HttpErrorResponse({
              status: 401,
              statusText: 'Unauthorized',
              url: req.url,
              error: { code: 'SESSION_EXPIRED' },
            }));
          }
        }
        // Only transport failures may enter the refresh-on-401 handler. A rejected
        // local session must not send the pending body or start another renewal.
        return next(req.clone({ setHeaders: authHeaders() })).pipe(catchError(handleError));
      }),
    );
  }

  const authedReq = shouldAuthenticate && (token || deviceId)
    ? req.clone({ setHeaders: authHeaders() })
    : req;

  return next(authedReq).pipe(catchError(handleError));
}

function isForceWipeError(error: unknown): boolean {
  if (!(error instanceof HttpErrorResponse)) {
    return false;
  }

  const actionHeader = error.headers?.get('X-Nivra-Action');
  const body = typeof error.error === 'object' && error.error !== null
    ? error.error as { code?: unknown }
    : null;
  return actionHeader === 'FORCE_WIPE' || body?.code === 'FORCE_WIPE';
}
