import { computed, signal } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { HubConnectionState } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { AuthService } from './auth.service';
import { ApiEndpointPool } from './api-endpoint-pool.service';
import { DESKTOP_PUSH_CONNECTION_FACTORY, DesktopInactivePushService } from './desktop-inactive-push.service';
import { NetworkPolicyService } from './network-policy.service';
import { NivraApiService } from './nivra-api.service';

describe('desktop inactive account notifications', () => {
  const account = (id: string, token = `own-${id}`) => ({ user: { id, alias: id }, device: { id: `device-${id}` }, tokens: { accessToken: token, refreshToken: `refresh-${id}` } });
  let service: DesktopInactivePushService; let active: ReturnType<typeof signal<any>>; let sessions: ReturnType<typeof signal<any[]>>;
  let generation: ReturnType<typeof signal<number>>; let auth: any; let created: any[]; let received: Record<string, string>[];
  let failingStarts: number;
  const flush = async () => { TestBed.flushEffects(); for (let index = 0; index < 25; index++) await Promise.resolve(); };
  beforeEach(() => {
    active = signal<any>(account('alice')); sessions = signal<any[]>([account('alice'), account('bob')]); generation = signal(0); created = []; received = []; failingStarts = 0;
    auth = { session: active, savedAccounts: computed(() => sessions().map(saved => ({ id: saved.user.id }))), sessionGeneration: generation,
      storedSessionCredentials: jasmine.createSpy('stored').and.callFake(async () => structuredClone(sessions())),
      getFreshStoredSessionCredentials: jasmine.createSpy('fresh').and.callFake(async (uid: string, did: string) => structuredClone(sessions().find(saved => saved.user.id === uid && saved.device.id === did) ?? null)) };
    TestBed.configureTestingModule({ providers: [DesktopInactivePushService,
      { provide: AuthService, useValue: auth }, { provide: NivraApiService, useValue: { url: (path: string) => `https://api.example.test${path}` } },
      { provide: ApiEndpointPool, useValue: { changes$: new Subject<string>() } },
      { provide: NetworkPolicyService, useValue: { serverTimeoutMs: () => 60_000, onlineHint: jasmine.createSpy().and.returnValue(true), retryDelayMs: jasmine.createSpy().and.returnValue(5000) } },
      { provide: DESKTOP_PUSH_CONNECTION_FACTORY, useValue: (url: string, token: () => Promise<string>, retry: any) => {
        const handlers = new Map<string, (payload: unknown) => void>(); let closed: (() => void) | undefined;
        const connection: any = { state: HubConnectionState.Disconnected,
          on: (name: string, listener: any) => handlers.set(name, listener), off: (name: string) => handlers.delete(name), onclose: (listener: any) => closed = listener,
          start: jasmine.createSpy('start').and.callFake(async () => {
            connection.state = HubConnectionState.Connecting; connection.usedToken = await token();
            if (failingStarts > 0) { failingStarts--; throw new Error('Fixture API unavailable'); }
            connection.state = HubConnectionState.Connected;
          }),
          stop: jasmine.createSpy('stop').and.callFake(async () => { connection.state = HubConnectionState.Disconnected; closed?.(); }),
        };
        created.push({ url, token, retry, connection, handlers, close: () => { connection.state = HubConnectionState.Disconnected; closed?.(); } }); return connection;
      } },
    ] }); service = TestBed.inject(DesktopInactivePushService); service.events$.subscribe(data => received.push(data));
  });
  afterEach(() => TestBed.resetTestingModule());

  it('opens only one receive-only channel with the inactive account own credential', async () => {
    service.enable(); await flush();
    expect(created.length).toBe(1); expect(created[0].connection.usedToken).toBe('own-bob');
    expect(auth.getFreshStoredSessionCredentials).toHaveBeenCalledWith('bob', 'device-bob');
    expect(created[0].handlers.has('conversation.typing')).toBeFalse(); expect(created[0].handlers.has('call.signal')).toBeFalse();
    expect(active().user.id).toBe('alice');
  });

  it('emits only scoped message and audio/video call routing IDs without names, text or ciphertext', async () => {
    service.enable(); await flush(); const hub = created[0];
    hub.handlers.get('message.received')({ id: 'message-1', conversationId: 'chat-b', senderUserId: 'peer', body: 'private text', ciphertext: 'private cipher', senderName: 'Secret Name' });
    hub.handlers.get('incomingCall')({ id: 'call-1', initiatorUserId: 'peer', type: 'Video', conversationId: 'chat-b', callerName: 'Secret Name' });
    expect(received.map(data => data['type'])).toEqual(['message', 'incoming_call']);
    expect(received.every(data => data['recipientUserId'] === 'bob' && data['recipientDeviceId'] === 'device-bob')).toBeTrue();
    expect(JSON.stringify(received)).not.toContain('Secret'); expect(JSON.stringify(received)).not.toContain('private');
    expect(received[1]['callType']).toBe('Video'); expect(active().user.id).toBe('alice');
  });

  it('ignores old callbacks on activation and reconnects with the other account credential', async () => {
    service.enable(); await flush(); const former = created[0]; const stale = former.handlers.get('message.received');
    active.set(account('bob')); generation.update(value => value + 1); await flush();
    expect(former.connection.stop).toHaveBeenCalled(); expect(former.handlers.size).toBe(0);
    expect(created[1].connection.usedToken).toBe('own-alice');
    stale({ id: 'late', conversationId: 'chat-b', senderUserId: 'peer' }); expect(received).toEqual([]);
  });

  it('stops and removes all event handlers when the inactive account is removed', async () => {
    service.enable(); await flush(); const former = created[0]; sessions.set([account('alice')]); await flush();
    expect(former.connection.stop).toHaveBeenCalled(); expect(former.handlers.size).toBe(0); expect(created.length).toBe(1);
  });

  it('bounds automatic reconnect and retrieves fresh credentials on every reconnect request', async () => {
    service.enable(); await flush(); const hub = created[0];
    expect(hub.retry.nextRetryDelayInMilliseconds({ previousRetryCount: 4 })).toBe(5000);
    expect(hub.retry.nextRetryDelayInMilliseconds({ previousRetryCount: 5 })).toBeNull();
    sessions.set([account('alice'), account('bob', 'rotated-bob')]);
    expect(await hub.token()).toBe('rotated-bob'); expect(active().tokens.accessToken).toBe('own-alice');
  });

  it('rejects an obsolete credential load after A to B to A before opening any hub', async () => {
    let resolve!: (value: any[]) => void;
    auth.storedSessionCredentials.and.returnValue(new Promise<any[]>(finish => resolve = finish));
    service.enable(); TestBed.flushEffects();
    active.set(account('bob')); generation.update(value => value + 1); active.set(account('alice')); generation.update(value => value + 1);
    resolve([account('alice'), account('bob')]);
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(created.length).toBe(0);
  });

  it('cancels scheduled startup retries on destruction without a polling loop', fakeAsync(() => {
    service.enable(); TestBed.flushEffects(); tick();
    const hub = created[0];
    expect(hub).toBeDefined();
    service.ngOnDestroy(); tick(60_000);
    expect(hub.connection.stop).toHaveBeenCalled(); expect(hub.handlers.size).toBe(0);
    expect(created.length).toBe(1);
  }));

  it('recovers after fast reconnect exhaustion without a visibility or network event', fakeAsync(() => {
    service.enable(); TestBed.flushEffects(); tick();
    const original = created[0]; original.close();
    expect((TestBed.inject(NetworkPolicyService).retryDelayMs as jasmine.Spy)).toHaveBeenCalledWith(0, 30_000, 120_000);
    tick(4999); expect(created.length).toBe(1);
    tick(1); expect(created.length).toBe(2); expect(created[1].connection.usedToken).toBe('own-bob');
    tick(120_000); expect(created.length).toBe(2); // Healthy hubs have no recovery timer.
    expect(active().user.id).toBe('alice');
  }));

  it('waits while offline and reconnects on online with the same inactive owner', fakeAsync(() => {
    service.enable(); TestBed.flushEffects(); tick();
    const network = TestBed.inject(NetworkPolicyService) as any;
    network.onlineHint.and.returnValue(false); window.dispatchEvent(new Event('offline')); created[0].close();
    tick(300_000); expect(created.length).toBe(1);
    network.onlineHint.and.returnValue(true); window.dispatchEvent(new Event('online')); tick();
    expect(created.length).toBe(2); expect(created[1].connection.usedToken).toBe('own-bob');
  }));

  it('cancels a slow recovery timer when its account is removed or service destroyed', fakeAsync(() => {
    service.enable(); TestBed.flushEffects(); tick(); created[0].close();
    sessions.set([account('alice')]); TestBed.flushEffects(); tick();
    tick(120_000); expect(created.length).toBe(1);
    sessions.set([account('alice'), account('bob')]); TestBed.flushEffects(); tick(); created[1].close();
    service.ngOnDestroy(); tick(120_000); expect(created.length).toBe(2);
  }));

  it('keeps recovering slowly after more than five unavailable initial handshakes', fakeAsync(() => {
    failingStarts = 7;
    service.enable(); TestBed.flushEffects(); tick();
    for (let attempt = 0; attempt < 7; attempt++) tick(5000);
    expect(created.length).toBe(8); expect(created[7].connection.state).toBe(HubConnectionState.Connected);
    const delays = (TestBed.inject(NetworkPolicyService).retryDelayMs as jasmine.Spy).calls.allArgs();
    expect(delays.some(args => args[1] === 30_000 && args[2] === 120_000)).toBeTrue();
    tick(120_000); expect(created.length).toBe(8); expect(active().user.id).toBe('alice');
  }));
});
