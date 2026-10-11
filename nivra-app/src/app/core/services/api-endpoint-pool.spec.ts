import { TestBed } from '@angular/core/testing';
import { API_POOL_RUNTIME, ApiEndpointPool, ApiPoolRuntime, apiOrigin } from './api-endpoint-pool.service';

describe('API endpoint pool isolation and failover', () => {
  const primary = 'https://primary.nivra.test', backup = 'https://backup.nivra.test', third = 'https://third.nivra.test';
  const pin = 'a'.repeat(64);
  const ready = (overrides = {}) => ({ failoverProtocol: 1, callProtocol: 2, minimumCallProtocol: 2, multiInstanceReady: true, clusterFingerprint: pin, push: { fcm: true, webPush: true }, ...overrides });
  let pool: ApiEndpointPool;
  let fetcher: jasmine.Spy;
  let runtime: ApiPoolRuntime;
  let now: number;
  const build = (stored = '', expected = '', preferred = '') => {
    now = 100000;
    fetcher = jasmine.createSpy('fetch').and.callFake(async () => new Response(JSON.stringify(ready())));
    runtime = { primary, origins: [primary, backup, third], expectedFingerprint: expected, preferred,
      fetch: fetcher, now: () => now, storage: { getItem: () => stored, setItem: jasmine.createSpy('persist') } };
    TestBed.configureTestingModule({ providers: [{ provide: API_POOL_RUNTIME, useValue: runtime }] });
    pool = TestBed.inject(ApiEndpointPool);
  };
  afterEach(() => TestBed.resetTestingModule());

  it('rejects unpinned origin, userinfo, insecure remote transport and origin-prefix tricks', () => {
    build();
    expect(apiOrigin('https://user@primary.nivra.test')).toBeNull();
    expect(apiOrigin('http://remote.test')).toBeNull();
    expect(apiOrigin('http://localhost:5055')).toBe('http://localhost:5055');
    expect(pool.isTrustedUrl(`${primary}.evil.test/me`)).toBeFalse();
    expect(pool.isTrustedUrl(`${backup}/me`)).toBeFalse();
  });
  it('coalesces simultaneous failure recovery and probes without credentials', async () => {
    build(); await pool.prepare(); fetcher.calls.reset();
    const changes: string[] = []; pool.changes$.subscribe(origin => changes.push(origin));
    const result = await Promise.all(Array.from({ length: 50 }, () => pool.recover(`${primary}/messages`)));
    expect(result.every(Boolean)).toBeTrue(); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(changes).toEqual([backup]); expect(pool.isTrustedUrl(`${backup}/me`)).toBeTrue();
    const options = fetcher.calls.first().args[1];
    expect(options.credentials).toBe('omit'); expect(options.redirect).toBe('error'); expect(options.headers).toBeUndefined();
  });
  it('rejects a different cluster and continues to a compatible registered node', async () => {
    build(); await pool.prepare();
    fetcher.and.callFake(async (url: string) => new Response(JSON.stringify(ready(url.startsWith(backup) ? { clusterFingerprint: 'b'.repeat(64) } : {}))));
    expect(await pool.recover(`${primary}/messages`)).toBeTrue(); expect(pool.current()).toBe(third);
    expect(pool.isTrustedUrl(`${backup}/me`)).toBeFalse();
  });
  it('never accepts missing push, missing Redis readiness or old failover protocol', async () => {
    for (const invalid of [{ push: { fcm: false, webPush: true } }, { multiInstanceReady: false }, { failoverProtocol: 0 }, { callProtocol: 1 }, { minimumCallProtocol: 3 }]) {
      TestBed.resetTestingModule(); build(); await pool.prepare();
      fetcher.and.callFake(async () => new Response(JSON.stringify(ready(invalid))));
      expect(await pool.recover(`${primary}/me`)).toBeFalse(); expect(pool.current()).toBe(primary);
    }
  });
  it('cannot bootstrap trust from a backup when a new device never saw the primary', async () => {
    build(); fetcher.and.callFake(async (url: string) => { if (url.startsWith(primary)) throw new Error('offline'); return new Response(JSON.stringify(ready())); });
    expect(await pool.recover(`${primary}/me`)).toBeFalse(); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses the last primary compatibility pin when the primary is unavailable on the next launch', async () => {
    build(pin); fetcher.and.callFake(async (url: string) => { if (url.startsWith(primary)) throw new Error('offline'); return new Response(JSON.stringify(ready())); });
    expect(await pool.recover(`${primary}/me`)).toBeTrue(); expect(pool.current()).toBe(backup);
  });
  it('does not send login or refresh twice after an ambiguous network failure', async () => {
    build(pin);
    fetcher.and.callFake(async (url: string) => { if (url.endsWith('/auth/refresh')) throw new Error('lost response'); return new Response(JSON.stringify(ready())); });
    await expectAsync(pool.fetch('/auth/refresh', { method: 'POST', body: 'synthetic' })).toBeRejected();
    expect(fetcher.calls.allArgs().filter(([url]) => String(url).endsWith('/auth/refresh')).length).toBe(1);
    expect(pool.current()).toBe(backup);
  });
  it('replays a safe read once, retaining query/path while choosing a compatible host', async () => {
    build(pin);
    fetcher.and.callFake(async (url: string) => url.startsWith(primary) ? new Response('', { status: 503 })
      : new Response(JSON.stringify(url.includes('/health/') ? ready() : { ok: true })));
    const response = await pool.fetch('/messages?before=123', {}, true);
    expect(await response.json()).toEqual({ ok: true });
    expect(fetcher.calls.mostRecent().args[0]).toBe(`${backup}/messages?before=123`);
  });
  it('does not switch servers on authorization errors or user rate limits', async () => {
    build(pin);
    for (const status of [401, 403, 409, 426, 429]) {
      fetcher.calls.reset(); fetcher.and.resolveTo(new Response('', { status }));
      expect((await pool.fetch('/messages', {}, true)).status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pool.current()).toBe(primary);
    }
  });
  it('does not replay a request after its authenticated scope changes during probing', async () => {
    build(pin); let current = true;
    fetcher.and.callFake(async (url: string) => {
      if (url.includes('/health/')) { current = false; return new Response(JSON.stringify(ready())); }
      throw new Error('offline');
    });
    await expectAsync(pool.fetch('/messages', {}, true, () => current)).toBeRejected();
    expect(fetcher.calls.allArgs().filter(([url]) => String(url).endsWith('/messages')).length).toBe(1);
  });
  it('requires compiled expected compatibility pins to match even on the primary', async () => {
    build('', 'b'.repeat(64)); await pool.prepare();
    expect(pool.clusterFingerprint()).toBe('b'.repeat(64));
    expect(await pool.recover(`${primary}/me`)).toBeFalse();
  });
  it('ignores arbitrary query/native origin preferences and never probes them', async () => {
    build('', '', 'https://attacker.test'); await pool.prepare();
    expect(pool.current()).toBe(primary); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('invalidates historical backup trust when the reachable primary explicitly disables shared infrastructure', async () => {
    build(pin); fetcher.and.resolveTo(new Response(JSON.stringify({ failoverProtocol: 1, multiInstanceReady: false, clusterFingerprint: null })));
    await pool.prepare(); expect(pool.clusterFingerprint()).toBe('');
    expect(await pool.recover(`${primary}/me`)).toBeFalse(); expect(pool.current()).toBe(primary);
  });
});
