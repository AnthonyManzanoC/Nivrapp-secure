import { HttpContextToken, HttpErrorResponse, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { NivraApiService, SKIP_AUTH } from '../services/nivra-api.service';

const AUTH_RETRIED = new HttpContextToken<boolean>(() => false);

export function authInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const auth = inject(AuthService);
  const api = inject(NivraApiService);
  const shouldAuthenticate = !req.context.get(SKIP_AUTH) && req.url.startsWith(api.baseUrl);
  const token = auth.accessToken();
  const authedReq = shouldAuthenticate && token
    ? req.clone({ setHeaders: { Authorization: `Bearer ${token}` } })
    : req;

  return next(authedReq).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        shouldAuthenticate &&
        !req.context.get(AUTH_RETRIED)
      ) {
        return from(auth.refreshToken()).pipe(
          switchMap((refreshed) => {
            if (!refreshed) {
              void auth.logout(true);
              return throwError(() => error);
            }
            const retry = req.clone({
              context: req.context.set(AUTH_RETRIED, true),
              setHeaders: { Authorization: `Bearer ${auth.accessToken()}` },
            });
            return next(retry);
          }),
        );
      }

      return throwError(() => error);
    }),
  );
}
