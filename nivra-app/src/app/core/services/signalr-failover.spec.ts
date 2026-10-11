import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HubConnection, HubConnectionBuilder, HubConnectionState } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('realtime failover and authenticated event scope', () => {
  let service: SignalrService, pool: { recover: jasmine.Spy; changes$: Subject<string> }, auth: any;
  let handlers: Map<string, (payload: unknown) => void>, session: ReturnType<typeof signal<any>>, connection: any;
  beforeEach(() => {
    session = signal<any>({ user: { id: 'alice' }, device: { id: 'phone' } }); handlers = new Map();
    pool = { recover: jasmine.createSpy('recover').and.resolveTo(false), changes$: new Subject() };
    auth = { session, accessToken: () => session() ? 'synthetic-token' : '', ensureFreshSession: async () => Boolean(session()), refreshToken: jasmine.createSpy('refresh').and.resolveTo(false) };
    connection = { state: HubConnectionState.Disconnected,
      on: (name: string, handler: (value: unknown) => void) => handlers.set(name, handler), off: (name: string) => handlers.delete(name),
      onreconnecting: jasmine.createSpy().and.callFake(handler => handlers.set('reconnecting', handler)), onreconnected: jasmine.createSpy(), onclose: jasmine.createSpy(),
      start: jasmine.createSpy('start').and.callFake(async () => { connection.state = HubConnectionState.Connected; }),
      stop: jasmine.createSpy('stop').and.resolveTo() };
    spyOn(HubConnectionBuilder.prototype, 'build').and.returnValue(connection as HubConnection);
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: ApiEndpointPool, useValue: pool },
      { provide: NivraApiService, useValue: { url: (path: string) => 'https://primary.test' + path } },
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
  it('cannot publish connected state from a handshake that finishes after account switching', async () => {
    let finish!: () => void;
    connection.start.and.returnValue(new Promise<void>(resolve => { finish = resolve; }));
    const listener = jasmine.createSpy('event'); service.events$.subscribe(listener);
    const pending = service.connect(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    session.set({ user: { id: 'bob' }, device: { id: 'other' } }); finish(); await pending;
    expect(listener).not.toHaveBeenCalled(); expect(connection.stop).toHaveBeenCalled();
  });
});
