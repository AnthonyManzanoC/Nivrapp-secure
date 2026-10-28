import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { API_POOL_RUNTIME, ApiEndpointPool, ApiPoolRuntime, apiOrigin } from './api-endpoint-pool.service';
import { NETWORK_POLICY_RUNTIME } from './network-policy.service';
import { environment as productionEnvironment } from '../../../environments/environment.prod';

describe('API endpoint pool isolation and failover', () => {
  const primary = 'https://primary.nivra.test', backup = 'https://backup.nivra.test', third = 'https://third.nivra.test';
  const pin = 'a'.repeat(64);
  const ready = (overrides = {}) => ({ status: 'ok', failoverProtocol: 1, callProtocol: 2, minimumCallProtocol: 2,
    sharedStorageReady: true, realtimeSharedReady: true, durableSigningKeyReady: true,
    multiInstanceReady: true, clusterFingerprint: pin, push: { fcm: true, webPush: true }, ...overrides });
  let pool: ApiEndpointPool;
  let fetcher: jasmine.Spy;
  let runtime: ApiPoolRuntime;
  let now: number;
  const build = (stored = '', expected = '', preferred = '') => {
    now = 100000;
    fetcher = jasmine.createSpy('fetch').and.callFake(async () => new Response(JSON.stringify(ready())));
    runtime = { primary, origins: [primary, backup, third], expectedFingerprint: expected, preferred,
      fetch: fetcher, now: () => now, storage: { getItem: () => stored, setItem: jasmine.createSpy('persist') } };
    TestBed.configureTestingModule({ providers: [{ provide: API_POOL_RUNTIME, useValue: runtime },
      { provide: NETWORK_POLICY_RUNTIME, useValue: { hints: () => ({}), onlineHint: () => true, now: () => now, random: () => .5 } }] });
    pool = TestBed.inject(ApiEndpointPool);
  };
  afterEach(() => TestBed.resetTestingModule());

  it('keeps the primary API first, then the existing and new Render backups', () => {
    expect(productionEnvironment.apiBaseUrl).toBe('https://nivrapp-secure.onrender.com');
    expect(productionEnvironment.apiEndpoints).toEqual([
      'https://nivrapp-secure.onrender.com',
      'https://nivra-webapp-secure.onrender.com',
      'https://nivrapp-secure-eaqi.onrender.com',
    ]);
  });

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
  it('never accepts missing core infrastructure, failed health or incompatible protocols', async () => {
    for (const invalid of [{ apiFailoverReady: false }, { realtimeSharedReady: false }, { sharedStorageReady: false }, { durableSigningKeyReady: false },
      { status: 'error' }, { failoverProtocol: 0 }, { callProtocol: 1 }, { minimumCallProtocol: 3 }, { minimumCallProtocol: 0 }, { callProtocol: '2' }, { realtimeSharedReady: 'true' }]) {
      TestBed.resetTestingModule(); build(); await pool.prepare();
      fetcher.and.callFake(async () => new Response(JSON.stringify(ready(invalid))));
      expect(await pool.recover(`${primary}/me`)).toBeFalse(); expect(pool.current()).toBe(primary);
    }
  });
  it('opens an authorized ready backup before the first login when the primary is already suspended', async () => {
    build('', pin);
    fetcher.and.callFake(async (url: string) => url.startsWith(primary) ? new Response('', { status: 503 })
      : new Response(JSON.stringify(url.endsWith('/health/ready') ? ready({ multiInstanceReady: false, push: { fcm: false, webPush: true } }) : { loggedIn: true })));
    const response = await pool.fetch('/auth/login', { method: 'POST', body: 'synthetic' });
    expect(await response.json()).toEqual({ loggedIn: true }); expect(pool.current()).toBe(backup);
    const logins = fetcher.calls.allArgs().filter(([url]) => String(url).endsWith('/auth/login'));
    expect(logins.length).toBe(1); expect(logins[0][0]).toBe(`${backup}/auth/login`);
    expect(pool.clusterFingerprint()).toBe(pin);
  });
  it('prepares once for concurrent initial requests and sends every mutation only to the healthy node', async () => {
    build('', pin);
    fetcher.and.callFake(async (url: string) => url.startsWith(primary) ? new Response('', { status: 503 })
      : new Response(JSON.stringify(url.endsWith('/health/ready') ? ready({ apiFailoverReady: true, multiInstanceReady: false }) : { ok: true })));
    await Promise.all(Array.from({ length: 20 }, () => pool.fetch('/messages', { method: 'POST', body: 'synthetic' })));
    expect(fetcher.calls.allArgs().filter(([url]) => String(url).endsWith('/health/ready')).length).toBe(2);
    const writes = fetcher.calls.allArgs().filter(([url]) => String(url).endsWith('/messages'));
    expect(writes.length).toBe(20); expect(writes.every(([url]) => url === `${backup}/messages`)).toBeTrue();
  });
  it('does not erase the compiled recovery pin because the primary has older or disabled infrastructure', async () => {
    build('', pin);
    fetcher.and.callFake(async (url: string) => new Response(JSON.stringify(url.startsWith(primary)
      ? { status: 'ok', failoverProtocol: 1, multiInstanceReady: false, clusterFingerprint: null } : ready())));
    await pool.prepare(); expect(pool.clusterFingerprint()).toBe(pin); expect(pool.current()).toBe(backup);
  });
  it('ignores cached readiness and moves on to another fresh compatible node', async () => {
    build(pin); await pool.prepare();
    fetcher.and.callFake(async (url: string) => new Response(JSON.stringify(ready()), { headers: url.startsWith(backup) ? { Age: '20' } : {} }));
    expect(await pool.recover(`${primary}/me`)).toBeTrue(); expect(pool.current()).toBe(third);
  });
  it('keeps a healthy backup selected when background primary readiness fails', async () => {
    build('', pin);
    fetcher.and.callFake(async (url: string) => url.startsWith(primary) ? new Response('', { status: 503 }) : new Response(JSON.stringify(ready())));
    await pool.prepare(); expect(pool.current()).toBe(backup); now += 61000;
    await pool.prepare(); expect(pool.current()).toBe(backup);
    expect(fetcher.calls.allArgs().filter(([url]) => String(url).startsWith(backup)).length).toBe(2);
    expect(fetcher.calls.allArgs().filter(([url]) => String(url).startsWith(primary)).length).toBe(1);
  });
  it('continues to a third verified node when the serving backup becomes unavailable', async () => {
    build('', pin);
    fetcher.and.callFake(async (url: string) => url.startsWith(primary)
      ? Promise.reject(new TypeError('Failed to fetch')) : new Response(JSON.stringify(ready())));
    await pool.prepare(); expect(pool.current()).toBe(backup);
    now += 61000; fetcher.calls.reset();
    fetcher.and.callFake(async (url: string) => url.startsWith(third)
      ? new Response(JSON.stringify(ready())) : Promise.reject(new TypeError('Failed to fetch')));
    await pool.prepare(); expect(pool.current()).toBe(third);
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
    await pool.prepare();
    for (const status of [401, 403, 409, 426, 429]) {
      fetcher.calls.reset(); fetcher.and.resolveTo(new Response('', { status }));
      expect((await pool.fetch('/messages', {}, true)).status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1); expect(pool.current()).toBe(primary);
    }
  });
  it('does not replay a request after its authenticated scope changes during probing', async () => {
    build(pin); let current = true;
    await pool.prepare();
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

  it('allows useful traffic on the trusted primary while an optional readiness request stalls', fakeAsync(() => {
    build();
    let finishProbe!: (value: Response) => void;
    fetcher.and.callFake((url: string) => url.endsWith('/health/ready')
      ? new Promise<Response>(resolve => finishProbe = resolve) : Promise.resolve(new Response('{}')));
    let response: Response | null = null;
    void pool.fetch('/messages').then(value => response = value);
    flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    tick(1001); flushMicrotasks();
    expect(response).toBeInstanceOf(Response);
    expect(fetcher.calls.mostRecent().args[0]).toBe(primary + '/messages');
    expect(pool.isTrustedUrl(backup + '/messages')).toBeFalse();
    finishProbe(new Response('', { status: 503 })); flushMicrotasks();
  }));

  it('uses successful serving traffic instead of repeatedly probing a healthy node', async () => {
    build(); await pool.prepare(); fetcher.calls.reset();
    now += 45000; pool.reportSuccess(primary + '/messages');
    now += 16000; await pool.prepare();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('backs off repeated total outages without sharing credentials with unverified hosts', async () => {
    build(); fetcher.and.rejectWith(new TypeError('offline'));
    expect(await pool.recover(primary + '/messages')).toBeFalse();
    await Promise.all(Array.from({ length: 50 }, () => pool.recover(primary + '/messages')));
    expect(fetcher).toHaveBeenCalledTimes(1);
    now += 3000;
    expect(await pool.recover(primary + '/messages')).toBeFalse();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(pool.isTrustedUrl(backup + '/messages')).toBeFalse();
  });

  it('does not start readiness or API work for an already canceled fetch', async () => {
    build(); const controller = new AbortController(); controller.abort();
    await expectAsync(pool.fetch('/messages', { signal: controller.signal }, true)).toBeRejected();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
