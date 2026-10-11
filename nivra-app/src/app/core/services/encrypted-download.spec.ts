import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { ENCRYPTED_FETCH, EncryptedDownloadService, validEncryptedDownload } from './encrypted-download.service';

describe('direct encrypted downloads', () => {
  let service: EncryptedDownloadService, fetcher: jasmine.Spy, api: { get: jasmine.Spy; getArrayBuffer: jasmine.Spy };
  let session: ReturnType<typeof signal<any>>;
  const ticket = (overrides = {}) => ({ url: 'https://bucket.storage.test/object?X-Amz-Signature=synthetic',
    expiresAt: new Date(Date.now() + 60000).toISOString(), encryptedSize: 3, contentType: 'application/octet-stream', ...overrides });
  beforeEach(() => {
    session = signal<any>({ user: { id: 'alice' }, device: { id: 'phone' } });
    api = { get: jasmine.createSpy('ticket').and.returnValue(of(ticket())), getArrayBuffer: jasmine.createSpy('proxy').and.returnValue(of(new Uint8Array([1, 2, 3]).buffer)) };
    fetcher = jasmine.createSpy('storage').and.resolveTo(new Response(new Uint8Array([1, 2, 3])));
    TestBed.configureTestingModule({ providers: [{ provide: NivraApiService, useValue: api },
      { provide: AuthService, useValue: { session } }, { provide: ENCRYPTED_FETCH, useValue: fetcher }] });
    service = TestBed.inject(EncryptedDownloadService);
  });
  afterEach(() => TestBed.resetTestingModule());
  it('downloads encrypted bytes without sending any session headers or referrer to storage', async () => {
    expect(new Uint8Array(await service.file('file-id'))).toEqual(new Uint8Array([1, 2, 3]));
    expect(api.getArrayBuffer).not.toHaveBeenCalled();
    const options = fetcher.calls.first().args[1];
    expect(options.credentials).toBe('omit'); expect(options.headers).toBeUndefined();
    expect(options.redirect).toBe('error'); expect(options.referrerPolicy).toBe('no-referrer');
  });
  it('falls back to the authorized proxy when an older API has no ticket endpoint', async () => {
    api.get.and.returnValue(throwError(() => new HttpErrorResponse({ status: 404 })));
    await service.file('file-id'); expect(fetcher).not.toHaveBeenCalled();
    expect(api.getArrayBuffer).toHaveBeenCalledOnceWith('/files/file-id/blob');
  });
  it('never downloads or falls back after an access denial or revocation', async () => {
    for (const status of [401, 403, 410]) {
      api.get.and.returnValue(throwError(() => new HttpErrorResponse({ status })));
      await expectAsync(service.file('file-id')).toBeRejected();
    }
    expect(fetcher).not.toHaveBeenCalled(); expect(api.getArrayBuffer).not.toHaveBeenCalled();
  });
  it('rejects credential URLs, expired capabilities, oversized objects and insecure origins', () => {
    expect(validEncryptedDownload(ticket({ url: 'https://user:pass@bucket.test/?X-Amz-Signature=x' }))).toBeFalse();
    expect(validEncryptedDownload(ticket({ url: 'http://bucket.test/?X-Amz-Signature=x' }))).toBeFalse();
    expect(validEncryptedDownload(ticket({ expiresAt: new Date(Date.now() - 1).toISOString() }))).toBeFalse();
    expect(validEncryptedDownload(ticket({ encryptedSize: 1024 * 1024 * 1024 }))).toBeFalse();
    expect(validEncryptedDownload(ticket({ url: 'https://bucket.test/object' }))).toBeFalse();
  });
  it('does not accept an oversized or truncated storage response as successful media', async () => {
    for (const bytes of [new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4])]) {
      fetcher.and.resolveTo(new Response(bytes));
      api.getArrayBuffer.and.returnValue(throwError(() => new Error('proxy unavailable')));
      await expectAsync(service.file('file-id')).toBeRejected();
    }
    expect(api.getArrayBuffer).not.toHaveBeenCalled();
  });
  it('cancels an invalid storage body before rejecting without a second download', async () => {
    const canceled = jasmine.createSpy('cancel');
    const body = new ReadableStream<Uint8Array>({ cancel: canceled });
    fetcher.and.resolveTo(new Response(body, { headers: { 'Content-Length': '1000000000' } }));
    await expectAsync(service.file('file-id')).toBeRejected();
    expect(canceled).toHaveBeenCalled(); expect(api.getArrayBuffer).not.toHaveBeenCalled();
  });
  it('does not return a previous account download after a session switch', async () => {
    fetcher.and.callFake(async () => { session.set({ user: { id: 'bob' }, device: { id: 'other' } }); return new Response(new Uint8Array([1, 2, 3])); });
    await expectAsync(service.file('file-id')).toBeRejected(); expect(api.getArrayBuffer).not.toHaveBeenCalled();
  });
});
