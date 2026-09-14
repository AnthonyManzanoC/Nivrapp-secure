import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
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
  beforeEach(() => {
    peers = new Map();
    for (const id of call.participantUserIds) {
      const transport = { packets$: new Subject<CallGamePacket>(), connectedPeers: signal(call.participantUserIds.filter(other => other !== id)),
        configure: () => undefined, reset: () => undefined,
        send: async (body: Record<string, unknown>, targets: string[]) => {
          for (const target of targets) peers.get(target)?.transport.packets$.next({ senderUserId: id, body: structuredClone(body) });
        } };
      TestBed.configureTestingModule({ providers: [{ provide: CallGameTransportService, useValue: transport }] });
      const service = TestBed.runInInjectionContext(() => new CallGameSessionService());
      service.configure(call, id);
      peers.set(id, { service, transport });
      TestBed.resetTestingModule();
    }
    alice = peers.get('alice')!.service; bob = peers.get('bob')!.service; carol = peers.get('carol')!.service;
  });
  afterEach(() => peers.forEach(peer => peer.service.ngOnDestroy()));
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

  it('clears the game when its creator leaves and on call end', () => {
    bob.create('trivia');
    alice.configure({ ...call, participantSessions: { alice: call.participantSessions!['alice'], carol: call.participantSessions!['carol'] } }, 'alice');
    expect(alice.state()).toBeNull();
    carol.reset(); expect(carol.state()).toBeNull(); expect(carol.panelOpen()).toBeFalse();
  });
});
