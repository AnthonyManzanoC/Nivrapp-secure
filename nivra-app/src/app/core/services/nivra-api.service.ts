import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { ApiEndpointPool } from './api-endpoint-pool.service';

export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);

@Injectable({ providedIn: 'root' })
export class NivraApiService {
  private readonly http = inject(HttpClient);
  private readonly pool = inject(ApiEndpointPool);
  get baseUrl(): string { return this.pool.current(); }
  get clusterFingerprint(): string { return this.pool.clusterFingerprint(); }
  isTrustedUrl(url: string): boolean { return this.pool.isTrustedUrl(url); }
  prepareEndpoints(): Promise<void> { return this.pool.prepare(); }
  recoverEndpoint(url: string): Promise<boolean> { return this.pool.recover(url); }
  fetch(path: string, options: RequestInit = {}, replaySafe = false, isCurrent = () => true): Promise<Response> {
    return this.pool.fetch(path, options, replaySafe, isCurrent);
  }

  url(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  get<T>(path: string, options: { skipAuth?: boolean } = {}) {
    return this.http.get<T>(this.url(path), {
      context: this.context(options.skipAuth),
    });
  }

  post<T>(path: string, body: unknown, options: { skipAuth?: boolean } = {}) {
    return this.http.post<T>(this.url(path), body, {
      context: this.context(options.skipAuth),
    });
  }

  patch<T>(path: string, body: unknown) {
    return this.http.patch<T>(this.url(path), body);
  }

  put<T>(path: string, body: unknown, options: { skipAuth?: boolean } = {}) {
    return this.http.put<T>(this.url(path), body, {
      context: this.context(options.skipAuth),
    });
  }

  putRaw<T>(path: string, body: ArrayBuffer | Blob, contentType = 'application/octet-stream') {
    return this.http.put<T>(this.url(path), body, {
      context: this.context(),
      headers: {
        'Content-Type': contentType,
      },
    });
  }

  getArrayBuffer(path: string) {
    return this.http.get(this.url(path), {
      context: this.context(),
      responseType: 'arraybuffer' as const,
    });
  }

  delete<T>(path: string) {
    return this.http.delete<T>(this.url(path));
  }

  private context(skipAuth = false): HttpContext {
    return new HttpContext().set(SKIP_AUTH, skipAuth);
  }

}
