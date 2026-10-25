import { HttpErrorResponse, HttpHandlerFn, HttpRequest, HttpResponse } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, from, switchMap, tap, throwError, timeout, TimeoutError } from 'rxjs';
import { ApiEndpointPool } from '../services/api-endpoint-pool.service';
import { AuthService } from '../services/auth.service';
import { NetworkPolicyService } from '../services/network-policy.service';

export function apiFailoverInterceptor(req: HttpRequest<unknown>, next: HttpHandlerFn) {
  const pool = inject(ApiEndpointPool);
  if (!pool.isConfiguredUrl(req.url)) return next(req);
  const auth = inject(AuthService);
  const network = inject(NetworkPolicyService);
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
    const startedAt = Date.now();
    const response = next(req.clone({ url })).pipe(tap(event => {
      if (event instanceof HttpResponse) {
        network.recordResponse(Date.now() - startedAt);
        if (event.ok) pool.reportSuccess(url);
      }
    }));
    return limited ? response.pipe(timeout({ each: network.readTimeoutMs() })) : response;
  };
  return from(pool.prepareForRequest()).pipe(switchMap(() => {
    const target = pool.rewrite(req.url);
    return send(target).pipe(catchError(error => {
      if (error instanceof TimeoutError) network.recordTimeout();
      if (!sameSession() || !(error instanceof TimeoutError || (error instanceof HttpErrorResponse && [0, 502, 503, 504].includes(error.status)))) {
        return throwError(() => error);
      }
      return from(pool.recover(target)).pipe(switchMap(changed =>
        changed && safe && sameSession() ? send(pool.rewrite(req.url)) : throwError(() => error)));
    }));
  }));
}
