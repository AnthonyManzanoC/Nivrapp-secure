import { HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { NivraApiService } from './nivra-api.service';
import { AuthService } from './auth.service';

interface DownloadAccess { url: string; expiresAt: string; encryptedSize: number; contentType: string }
const MAX_ENCRYPTED_BYTES = 256 * 1024 * 1024 + 4096;
class EncryptedObjectIntegrityError extends Error { }
export const ENCRYPTED_FETCH = new InjectionToken<typeof fetch>('ENCRYPTED_FETCH', { providedIn: 'root', factory: () => (input, init) => globalThis.fetch(input, init) });

export function validEncryptedDownload(value: unknown, now = Date.now()): value is DownloadAccess {
  if (!value || typeof value !== 'object') return false;
  const access = value as DownloadAccess;
  if (!Number.isSafeInteger(access.encryptedSize) || access.encryptedSize < 1 || access.encryptedSize > MAX_ENCRYPTED_BYTES
      || access.contentType !== 'application/octet-stream' || typeof access.expiresAt !== 'string') return false;
  const expiry = Date.parse(access.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 65000) return false;
  try {
    const url = new URL(access.url);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.port
      && Boolean(url.searchParams.get('X-Amz-Signature'))
      && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

@Injectable({ providedIn: 'root' })
export class EncryptedDownloadService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly fetch = inject(ENCRYPTED_FETCH);

  file(id: string, isCurrent = () => true): Promise<ArrayBuffer> {
    const path = `/files/${encodeURIComponent(id)}`;
    return this.download(`${path}/download-access`, `${path}/blob`, isCurrent);
  }

  async download(accessPath: string, fallbackPath: string, isCurrent = () => true): Promise<ArrayBuffer> {
    const session = this.auth.session();
    const current = () => isCurrent() && this.auth.session()?.user.id === session?.user.id && this.auth.session()?.device.id === session?.device.id;
    const assertCurrent = () => { if (!current()) throw new Error('Download context changed'); };
    let expectedSize: number | null = null;
    assertCurrent();
    try {
      const access = await firstValueFrom(this.api.get<DownloadAccess | null>(accessPath));
      assertCurrent();
      if (validEncryptedDownload(access)) {
        expectedSize = access.encryptedSize;
        const response = await this.fetch(access.url, {
          credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: AbortSignal.timeout(60000),
        });
        if (!current() || !response.ok || !response.body) {
          await response.body?.cancel().catch(() => undefined);
          assertCurrent();
          throw new Error('Direct encrypted download unavailable');
        }
        const advertised = response.headers.get('Content-Length');
        if (advertised && Number(advertised) !== access.encryptedSize) {
          await response.body.cancel().catch(() => undefined);
          throw new EncryptedObjectIntegrityError('Invalid encrypted object size');
        }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          while (true) {
            const { value, done } = await reader.read();
            assertCurrent();
            if (done) break;
            total += value.length;
            if (total > access.encryptedSize) throw new EncryptedObjectIntegrityError('Invalid encrypted object size');
            chunks.push(value);
          }
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
        if (total !== access.encryptedSize) throw new EncryptedObjectIntegrityError('Incomplete encrypted object');
        const result = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        assertCurrent(); return result.buffer;
      }
    } catch (error) {
      assertCurrent();
      if (error instanceof EncryptedObjectIntegrityError) throw error;
      if (error instanceof HttpErrorResponse && [401, 403, 410].includes(error.status)) throw error;
      // Older/single-node APIs and storage without browser CORS retain the authorized encrypted proxy.
    }
    assertCurrent();
    const bytes = await firstValueFrom(this.api.getArrayBuffer(fallbackPath));
    assertCurrent();
    if (!bytes.byteLength || bytes.byteLength > MAX_ENCRYPTED_BYTES || (expectedSize !== null && bytes.byteLength !== expectedSize))
      throw new EncryptedObjectIntegrityError('Invalid encrypted object size');
    return bytes;
  }
}
