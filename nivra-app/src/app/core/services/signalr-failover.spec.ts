import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('realtime failover and authenticated event scope', () => {
  let service: SignalrService, pool: { prepare: jasmine.Spy; recover: jasmine.Spy; changes$: Subject<string> }, auth: any;
  let handlers: Map<string, (payload: unknown) => void>, session: ReturnType<typeof signal<any>>, connection: any;
  let selected: string, build: jasmine.Spy;
  beforeEach(() => {
    selected = 'https://primary.test';
    session = signal<any>({ user: { id: 'alice' }, device: { id: 'phone' } }); handlers = new Map();
    pool = { prepare: jasmine.createSpy('prepare').and.resolveTo(), recover: jasmine.createSpy('recover').and.resolveTo(false), changes$: new Subject() };
    auth = { session, accessToken: () => session() ? 'synthetic-token' : '', ensureFreshSession: async () => Boolean(session()), refreshToken: jasmine.createSpy('refresh').and.resolveTo(false) };
    connection = { state: HubConnectionState.Disconnected,
      on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler), off: (name: string) => handlers.delete(name),
      onreconnecting: jasmine.createSpy().and.callFake(handler => handlers.set('reconnecting', handler)), onreconnected: jasmine.createSpy(), onclose: jasmine.createSpy(),
      start: jasmine.createSpy('start').and.callFake(async () => { connection.state = HubConnectionState.Connected; }),
      stop: jasmine.createSpy('stop').and.resolveTo() };
    build = spyOn(HubConnectionBuilder.prototype, 'build').and.returnValue(connection as HubConnection);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: ApiEndpointPool, useValue: pool },
      { provide: NivraApiService, useValue: { url: (path: string) => selected + path } },
    ] });
    service = TestBed.inject(SignalrService);
  });
  afterEach(async () => { service.ngOnDestroy(); await service.disconnect(); TestBed.resetTestingModule(); });
  it('does not switch origin or rotate credentials for permissions, throttles or protocol errors', async () => {
    for (const statusCode of [403, 429, 426]) {
      connection.start.and.rejectWith({ statusCode }); await service.connect(); await service.disconnect();
    }
    expect(pool.recover).not.toHaveBeenCalled(); expect(auth.refreshToken).not.toHaveBeenCalled();
  });
  it('checks a healthy shared backup for an infrastructure error while keeping the session', async () => {
    connection.start.and.rejectWith({ statusCode: 503 }); await service.connect();
    expect(pool.recover).toHaveBeenCalledOnceWith('https://primary.test/hubs/realtime');
    expect(auth.refreshToken).not.toHaveBeenCalled(); expect(session().user.id).toBe('alice');
  });
  it('suppresses stale hub messages and wipe instructions after a different account enters', async () => {
    await service.connect(); const message = handlers.get('message.received')!, wipe = handlers.get('FORCE_WIPE')!;
    const listener = jasmine.createSpy('event'); service.events$.subscribe(listener);
    session.set({ user: { id: 'bob' }, device: { id: 'different' } });
    message({ text: 'old ciphertext' }); wipe({ code: 'FORCE_WIPE' }); expect(listener).not.toHaveBeenCalled();
  });
  it('checks a replacement promptly when an established connection loses its server', async () => {
    await service.connect();
    const reconnect = handlers.get('reconnecting')!;
    reconnect({ statusCode: 503 }); await Promise.resolve();
    expect(pool.recover).toHaveBeenCalledOnceWith('https://primary.test/hubs/realtime');
    pool.recover.calls.reset(); reconnect({ statusCode: 429 });
    expect(pool.recover).not.toHaveBeenCalled();
    session.set({ user: { id: 'bob' }, device: { id: 'other' } }); reconnect({ statusCode: 503 });
    expect(pool.recover).not.toHaveBeenCalled();
  });
  it('cannot publish connected state from a handshake that finishes after account switching', fakeAsync(() => {
    let finish!: () => void;
    connection.start.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    const listener = jasmine.createSpy('event'); service.events$.subscribe(listener);
    void service.connect(); flushMicrotasks();
    session.set({ user: { id: 'bob' }, device: { id: 'other' } }); finish(); flushMicrotasks();
    expect(listener).not.toHaveBeenCalled(); expect(connection.stop).toHaveBeenCalled();
  }));
  it('opens the replacement hub after an old pending handshake releases its start promise', fakeAsync(() => {
    let rejectStart!: (error: unknown) => void;
    connection.start.and.returnValue(new Promise<void>((_resolve, reject) => { rejectStart = reject; }));
    const replacement: any = {
      state: HubConnectionState.Disconnected, on: () => undefined, off: () => undefined,
      onreconnecting: () => undefined, onreconnected: () => undefined, onclose: () => undefined,
      start: jasmine.createSpy('replacement.start').and.callFake(async () => { replacement.state = HubConnectionState.Connected; }),
      stop: jasmine.createSpy('replacement.stop').and.resolveTo(),
    };
    build.and.returnValues(connection as HubConnection, replacement as HubConnection);
    const urls = spyOn(HubConnectionBuilder.prototype, 'withUrl').and.callThrough();
    const listener = jasmine.createSpy('event'); service.events$.subscribe(listener);
    void service.connect(); flushMicrotasks();
    selected = 'https://backup.test'; pool.changes$.next(selected); flushMicrotasks();
    tick(0); flushMicrotasks();
    expect(build).toHaveBeenCalledTimes(1);
    rejectStart({ statusCode: 503 }); flushMicrotasks(); tick(0); flushMicrotasks();
    expect(build).toHaveBeenCalledTimes(2);
    expect(urls.calls.mostRecent().args[0]).toBe('https://backup.test/hubs/realtime');
    expect(replacement.start).toHaveBeenCalledTimes(1);
    expect(service.connected()).toBeTrue();
    expect(listener).toHaveBeenCalledOnceWith({ type: 'connected', payload: null });
  }));
  it('selects the prepared backup before opening its first hub', async () => {
    pool.prepare.and.callFake(async () => { selected = 'https://backup.test'; });
    const urls = spyOn(HubConnectionBuilder.prototype, 'withUrl').and.callThrough();
    await service.connect();
    expect(pool.prepare).toHaveBeenCalledTimes(1);
    expect(urls).toHaveBeenCalledOnceWith('https://backup.test/hubs/realtime', jasmine.any(Object));
    expect(urls.calls.first().args[1]).toEqual(jasmine.objectContaining({ timeout: 15000, withCredentials: false }));
  });
  it('does not open a hub for an owner that changed during endpoint preparation', async () => {
    pool.prepare.and.callFake(async () => { session.set({ user: { id: 'bob' }, device: { id: 'other' } }); });
    await service.connect();
    expect(build).not.toHaveBeenCalled();
  });
  it('cancels a deferred endpoint restart when the user logs out during the old handshake', fakeAsync(() => {
    let rejectStart!: (error: unknown) => void;
    connection.start.and.returnValue(new Promise<void>((_resolve, reject) => { rejectStart = reject; }));
    const listener = jasmine.createSpy('event'); service.events$.subscribe(listener);
    void service.connect(); flushMicrotasks();
    selected = 'https://backup.test'; pool.changes$.next(selected); flushMicrotasks();
    session.set(null); void service.disconnect(); flushMicrotasks();
    rejectStart({ statusCode: 503 }); flushMicrotasks(); tick(0); flushMicrotasks();
    expect(build).toHaveBeenCalledTimes(1);
    expect(service.connectionState()).toBe(HubConnectionState.Disconnected);
    expect(listener).not.toHaveBeenCalled();
  }));
  it('preserves a newer connected state when an old stop finishes late', async () => {
    await service.connect();
    let finishStop!: () => void;
    connection.stop.and.returnValue(new Promise<void>(resolve => { finishStop = resolve; }));
    const stopping = service.disconnect();
    const replacement: any = {
      state: HubConnectionState.Disconnected, on: () => undefined, off: () => undefined,
      onreconnecting: () => undefined, onreconnected: () => undefined, onclose: () => undefined,
      start: jasmine.createSpy('replacement.start').and.callFake(async () => { replacement.state = HubConnectionState.Connected; }),
      stop: jasmine.createSpy('replacement.stop').and.resolveTo(),
    };
    build.and.returnValue(replacement as HubConnection);
    await service.connect();
    expect(service.connected()).toBeTrue();
    finishStop(); await stopping;
    expect(service.connected()).toBeTrue();
  });
});
