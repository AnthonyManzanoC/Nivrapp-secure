import { HttpErrorResponse, HttpHandlerFn, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, throwError, timeout, TimeoutError } from 'rxjs';
import { ApiEndpointPool } from '../services/api-endpoint-pool.service';
import { AuthService } from '../services/auth.service';

export function apiFailoverInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const pool = inject(ApiEndpointPool);
  if (!pool.isConfiguredUrl(req.url)) return next(req);
  const auth = inject(AuthService);
  const session = auth.session();
  const sameSession = () => auth.session()?.user.id === session?.user.id && auth.session()?.device.id === session?.device.id;
  const safe = req.method === 'GET' || req.method === 'HEAD'
    || (req.method === 'POST' && new URL(req.url).pathname === '/keys/batch');
  // Downloads and uploads keep their own progress/limits; small read requests cannot hang forever.
  let smallBody = req.body == null;
  if (!smallBody && !(req.body instanceof Blob || req.body instanceof ArrayBuffer || req.body instanceof FormData)) {
    try { smallBody = JSON.stringify(req.body).length <= 1024 * 1024; } catch { /* Unsupported bodies retain their own lifecycle. */ }
  }
  const limited = smallBody && req.responseType !== 'arraybuffer' && !req.reportProgress;
  const send = (url: string) => {
    if (!sameSession()) return throwError(() => new Error('Session changed'));
    const response = next(req.clone({ url }));
    return limited ? response.pipe(timeout({ each: 15000 })) : response;
  };
  const target = pool.rewrite(req.url);
  return send(target).pipe(catchError(error => {
    if (!sameSession() || !(error instanceof TimeoutError || (error instanceof HttpErrorResponse && [0, 502, 503, 504].includes(error.status)))) {
      return throwError(() => error);
    }
    return from(pool.recover(target)).pipe(switchMap(changed =>
      changed && safe && sameSession() ? send(pool.rewrite(req.url)) : throwError(() => error)));
  }));
}
