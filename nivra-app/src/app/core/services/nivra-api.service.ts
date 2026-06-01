import { HttpClient, HttpContext, HttpContextToken } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { environment } from '../../../environments/environment';

export const SKIP_AUTH = new HttpContextToken<boolean>(() => false);

@Injectable({ providedIn: 'root' })
export class NivraApiService {
  private readonly http = inject(HttpClient);
  readonly baseUrl = this.resolveBaseUrl();

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

  private resolveBaseUrl(): string {
    const configured = this.queryApiBaseUrl()
      || this.windowApiBaseUrl()
      || environment.apiBaseUrl;
    return configured.replace(/\/+$/, '');
  }

  private queryApiBaseUrl(): string {
    try {
      const value = new URLSearchParams(window.location.search).get('apiBaseUrl') || '';
      return /^https?:\/\//i.test(value) ? value : '';
    } catch {
      return '';
    }
  }

  private windowApiBaseUrl(): string {
    const value = (globalThis as { NIVRA_NATIVE_API_BASE_URL?: unknown }).NIVRA_NATIVE_API_BASE_URL;
    return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
  }
}
