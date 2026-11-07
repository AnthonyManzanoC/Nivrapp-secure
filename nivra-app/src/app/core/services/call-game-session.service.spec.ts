import { signal } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { CallSession } from '../models/nivra.models';
import { CallGameSessionService } from './call-game-session.service';
import { CallGameTransportService, CallGamePacket } from './call-game-transport.service';

describe('shared call game session', () => {
  let alice: CallGameSessionService;
  let bob: CallGameSessionService;
  let carol: CallGameSessionService;
  let peers: Map<string, { service: CallGameSessionService; transport: any }>;
  const call: CallSession = { id: 'call', initiatorUserId: 'alice', type: 'Voice', status: 'Active', startedAt: '',
    participantUserIds: ['alice', 'bob', 'carol'], participantSessions: {
      alice: { deviceId: 'a', clientSessionId: 'aa' }, bob: { deviceId: 'b', clientSessionId: 'bb' }, carol: { deviceId: 'c', clientSessionId: 'cc' },
    } };
  beforeEach(async () => {
    peers = new Map();
    for (const id of call.participantUserIds) {
      const transport = { packets$: new Subject<CallGamePacket>(), connectedPeers: signal(call.participantUserIds.filter(other => other !== id)),
        configure: () => undefined, reset: () => undefined,
        send: async (body: Record<string, unknown>, targets: string[]) => {
          for (const target of targets) peers.get(target)?.transport.packets$.next({ senderUserId: id, body: structuredClone(body) });
        } };
      TestBed.configureTestingModule({ providers: [{ provide: CallGameTransportService, useValue: transport }] });
      const service = TestBed.runInInjectionContext(() => new CallGameSessionService());
      await service.loadEngine();
      service.configure(call, id);
      peers.set(id, { service, transport });
      TestBed.resetTestingModule();
    }
    alice = peers.get('alice')!.service; bob = peers.get('bob')!.service; carol = peers.get('carol')!.service;
  });
  afterEach(() => peers.forEach(peer => peer.service.ngOnDestroy()));
  it('preserves packet order while the game engine downloads', async () => {
    const engine = (bob as any).engine;
    (bob as any).engine = undefined;
    let release!: () => void;
    const loaded = new Promise<void>(resolve => release = () => { (bob as any).engine = engine; resolve(); });
    spyOn(bob, 'loadEngine').and.callFake(() => { (bob as any).enginePending = loaded; return loaded; });
    const transport = peers.get('bob')!.transport;
    transport.packets$.next({ senderUserId: 'alice', body: { type: 'state', state: engine.createCallGame('tic-tac-toe', 'loading-game', 'alice') } });
    transport.packets$.next({ senderUserId: 'alice', body: { type: 'state', state: null } });
    release(); await loaded; await Promise.resolve();
    expect(bob.state()).toBeNull();
  });
  it('discards a game received for a call that ended during loading', async () => {
    const engine = (bob as any).engine;
    (bob as any).engine = undefined;
    let release!: () => void;
    const loaded = new Promise<void>(resolve => release = () => { (bob as any).engine = engine; resolve(); });
    spyOn(bob, 'loadEngine').and.returnValue(loaded);
    peers.get('bob')!.transport.packets$.next({ senderUserId: 'alice', body: { type: 'state', state: engine.createCallGame('tic-tac-toe', 'old-call-game', 'alice') } });
    bob.reset(); release(); await loaded; await Promise.resolve();
    expect(bob.state()).toBeNull();
  });
  const act = (service: CallGameSessionService, type: 'join' | 'start' | 'move', index = 0) => {
    const state = service.state()!;
    service.act(type === 'move' ? { type, gameId: state.id, expectedRevision: state.revision, index } : { type, gameId: state.id, expectedRevision: state.revision });
  };

  it('lets a non-coordinator create, join and play one shared game', () => {
    bob.create('tic-tac-toe');
    expect(alice.state()?.hostUserId).toBe('bob');
    act(carol, 'join'); act(bob, 'start'); act(bob, 'move', 0); act(carol, 'move', 4);
    expect(alice.state()?.board[0]).toBe('bob');
    expect(alice.state()?.board[4]).toBe('carol');
    expect(bob.state()).toEqual(alice.state()); expect(carol.state()).toEqual(alice.state());
  });
  it('shows a short invitation and only one reminder to people who have not joined',fakeAsync(()=>{
    bob.create('trivia');expect(alice.invitationVisible()).toBeTrue();expect(bob.invitationVisible()).toBeFalse();
    tick(6500);expect(alice.invitationVisible()).toBeFalse();tick(38500);expect(alice.invitationVisible()).toBeTrue();
    tick(6500);expect(alice.invitationVisible()).toBeFalse();tick(90000);expect(alice.invitationVisible()).toBeFalse();
    peers.forEach(peer=>peer.service.reset());
  }));
  it('joins from the invitation and prevents reminders after joining or changing calls',fakeAsync(()=>{
    bob.create('tic-tac-toe');carol.acceptInvitation();
    expect(carol.state()?.playerIds).toContain('carol');expect(carol.panelOpen()).toBeTrue();expect(alice.invitationVisible()).toBeFalse();
    alice.reset();tick(60000);expect(alice.invitationVisible()).toBeFalse();peers.forEach(peer=>peer.service.reset());
  }));
  it('honors an explicit dismissal without cancelling another person’s game',fakeAsync(()=>{
    bob.create('trivia');const id=bob.state()?.id;carol.dismissInvitation();tick(60000);
    expect(carol.invitationVisible()).toBeFalse();expect(bob.state()?.id).toBe(id);peers.forEach(peer=>peer.service.reset());
  }));

  it('serializes simultaneous game creation without replacing a lobby', () => {
    bob.create('connect-four'); const id = bob.state()!.id;
    carol.create('trivia');
    expect(carol.state()?.id).toBe(id); expect(carol.error()).toContain('Ya hay');
  });

  it('ignores forged state snapshots from a non-coordinator', () => {
    bob.create('trivia');
    const current = bob.state();
    peers.get('bob')!.transport.packets$.next({ senderUserId: 'carol', body: { type: 'state', state: null } });
    expect(bob.state()).toBe(current);
  });

  it('does not accept a second stale move or a move for someone else', () => {
    bob.create('tic-tac-toe'); act(carol, 'join'); act(bob, 'start');
    const stale = { type: 'move' as const, gameId: bob.state()!.id, expectedRevision: bob.state()!.revision, index: 0 };
    bob.act(stale); bob.act({ ...stale, index: 1 });
    expect(alice.state()?.board[1]).toBeNull();
    act(alice, 'move', 2); expect(alice.state()?.board[2]).toBeNull();
  });

  it('lets the creator close an empty lobby and start a different game without hanging up', () => {
    bob.create('connect-four');
    bob.leaveGame(true);
    expect(bob.panelOpen()).toBeFalse();
    expect(alice.state()).toBeNull();
    expect(carol.state()).toBeNull();
    bob.create('trivia');
    expect(carol.state()?.kind).toBe('trivia');
  });

  it('does not let a spectator cancel the group game', () => {
    bob.create('trivia');
    carol.leaveGame(true);
    expect(bob.state()?.kind).toBe('trivia');
    peers.get('alice')!.transport.packets$.next({ senderUserId: 'carol', body: { type: 'cancel', gameId: bob.state()!.id, requestId: 'forged-cancel' } });
    expect(alice.state()?.kind).toBe('trivia');
  });

  it('releases a two-player lobby when a player leaves so either can choose another game', () => {
    bob.create('tic-tac-toe');
    act(carol, 'join');
    carol.leaveGame();
    expect(bob.state()).toBeNull();
    carol.create('connect-four');
    expect(bob.state()?.hostUserId).toBe('carol');
  });

  it('clears the game when its creator leaves and on call end', () => {
    bob.create('trivia');
    alice.configure({ ...call, participantSessions: { alice: call.participantSessions!['alice'], carol: call.participantSessions!['carol'] } }, 'alice');
    expect(alice.state()).toBeNull();
    carol.reset(); expect(carol.state()).toBeNull(); expect(carol.panelOpen()).toBeFalse();
  });
});
