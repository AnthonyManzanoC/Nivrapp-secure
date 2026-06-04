import { HttpContextToken, HttpErrorResponse, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { DeviceWipeService } from '../services/device-wipe.service';
import { NivraApiService, SKIP_AUTH } from '../services/nivra-api.service';

const AUTH_RETRIED = new HttpContextToken<boolean>(() => false);

export function authInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const auth = inject(AuthService);
  const api = inject(NivraApiService);
  const wipe = inject(DeviceWipeService);
  const shouldAuthenticate = !req.context.get(SKIP_AUTH) && req.url.startsWith(api.baseUrl);
  const token = auth.accessToken();
  const deviceId = auth.session()?.device.id || '';
  const authHeaders = () => ({
    ...(auth.accessToken() ? { Authorization: `Bearer ${auth.accessToken()}` } : {}),
    ...(deviceId ? { 'X-Nivra-Device-Id': deviceId } : {}),
  });
  if (shouldAuthenticate && token && !auth.hasFreshAccessToken()) {
    return from(auth.ensureFreshSession()).pipe(
      switchMap((refreshed) => {
        if (!refreshed) {
          if (auth.lastRefreshFailedPermanently()) {
            void auth.logout(true);
          }
          return next(req.clone({ setHeaders: authHeaders() }));
        }
        return next(req.clone({ setHeaders: authHeaders() }));
      }),
    );
  }

  const authedReq = shouldAuthenticate && (token || deviceId)
    ? req.clone({ setHeaders: authHeaders() })
    : req;

  return next(authedReq).pipe(
    catchError((error: unknown) => {
      if (isForceWipeError(error)) {
        void wipe.nukeDevice();
        return throwError(() => error);
      }

      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        shouldAuthenticate &&
        !req.context.get(AUTH_RETRIED)
      ) {
        return from(auth.refreshToken()).pipe(
          switchMap((refreshed) => {
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
            return next(retry);
          }),
        );
      }

      return throwError(() => error);
    }),
  );
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
