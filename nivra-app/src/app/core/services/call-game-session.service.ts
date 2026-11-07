import { Injectable, OnDestroy, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { CallSession } from '../models/nivra.models';
import type { CallGameAction, CallGameKind, CallGameState } from '../games/call-game-engine';
import { CallGameTransportService, type CallGamePacket } from './call-game-transport.service';

const KINDS: readonly string[] = ['tic-tac-toe', 'connect-four', 'trivia', 'gomoku', 'take-away', 'reversi', 'hex', 'dots-boxes'];

/** One coordinator serializes moves; the game's creator controls its lobby.
 * State lives only for the call. A participant cannot submit a move for someone else.
 */
@Injectable({ providedIn: 'root' })
export class CallGameSessionService implements OnDestroy {
  readonly transport = inject(CallGameTransportService);
  readonly state = signal<CallGameState | null>(null);
  readonly panelOpen = signal(false);
  readonly browsing = signal(false);
  readonly error = signal('');
  readonly ready = computed(() => this.transport.connectedPeers().length > 0);
  readonly invitationVisible = signal(false);
  private invitationGameId = '';
  private dismissedInvitationId = '';
  private readonly invitationTimers = new Set<ReturnType<typeof setTimeout>>();
  private engine?: typeof import('../games/call-game-engine');
  private enginePending?: Promise<void>;
  private epoch = 0;
  async loadEngine(): Promise<void> {
    if (this.engine) return;
    return this.enginePending ??= import('../games/call-game-engine').then(engine => { this.engine = engine; }).finally(() => { this.enginePending = undefined; });
  }
  private callId = '';
  private localUserId = '';
  private users: string[] = [];
  private coordinator = '';
  private readonly subscription: Subscription;
  private seenPeers: string[] = [];
  private readonly requests = new Set<string>();

  constructor() {
    this.subscription = this.transport.packets$.subscribe(packet => this.receive(packet));
    effect(() => {
      this.panelOpen(); this.ready();
      untracked(() => this.updateInvitation());
    });
    effect(() => {
      const peers = this.transport.connectedPeers();
      untracked(() => {
        const added = peers.filter(id => !this.seenPeers.includes(id));
        this.seenPeers = [...peers];
        if (!this.callId || !added.length) return;
        if (this.coordinator === this.localUserId) this.broadcast(added);
        else if (peers.includes(this.coordinator)) this.send({ type: 'sync' }, [this.coordinator]);
      });
    });
  }

  configure(call: CallSession, localUserId: string): void {
    if (this.callId !== call.id || this.localUserId !== localUserId) this.reset();
    const previousCoordinator = this.coordinator;
    this.callId = call.id;
    this.localUserId = localUserId;
    this.users = Object.keys(call.participantSessions ?? {}).filter(id => call.participantUserIds.includes(id)).sort();
    this.coordinator = this.users[0] ?? '';
    this.transport.configure(call.id, this.users.filter(id => id !== localUserId));
    const current = this.state();
    if (current && !this.users.includes(current.hostUserId)) {
      this.setGameState(null);
      this.error.set('Quien creó la partida salió de la llamada. Puedes iniciar otra.');
    } else if (current && this.coordinator === localUserId) {
      for (const playerId of current.playerIds.filter(id => !this.users.includes(id))) {
        const latest = this.state()!;
        const result = this.engine!.applyCallGameAction(latest, playerId, { type: 'leave', gameId: latest.id, expectedRevision: latest.revision });
        if (result.accepted) this.setGameState(result.state);
      }
      if (this.state() !== current || previousCoordinator !== this.coordinator) this.broadcast();
    }
    if (previousCoordinator !== this.coordinator && this.coordinator && this.coordinator !== localUserId && this.transport.connectedPeers().includes(this.coordinator)) {
      this.send({ type: 'sync' }, [this.coordinator]);
    }
  }

  create(kind: CallGameKind): void {
    this.error.set('');
    this.browsing.set(false);
    this.panelOpen.set(true);
    this.request({ type: 'create', kind });
  }

  act(action: CallGameAction): void {
    this.error.set('');
    this.request({ type: 'action', action });
  }

  leaveGame(closePanel = false): void {
    const current = this.state();
    if (current?.hostUserId === this.localUserId) {
      this.request({ type: 'cancel', gameId: current.id });
    } else if (current?.playerIds.includes(this.localUserId)) {
      this.act({ type: 'leave', gameId: current.id, expectedRevision: current.revision });
    }
    this.browsing.set(true);
    this.error.set('');
    if (closePanel) this.panelOpen.set(false);
    // Keep the call's transport available for the next game. No media tracks
    // or peer connections belong to the transient panel component.
  }

  reset(): void {
    ++this.epoch;
    this.clearInvitationTimers();
    this.invitationVisible.set(false); this.invitationGameId = ''; this.dismissedInvitationId = '';
    this.callId = '';
    this.localUserId = '';
    this.coordinator = '';
    this.users = [];
    this.seenPeers = [];
    this.requests.clear();
    this.setGameState(null);
    this.panelOpen.set(false);
    this.browsing.set(false);
    this.error.set('');
    this.transport.reset();
  }

  ngOnDestroy(): void { this.subscription.unsubscribe(); this.reset(); }

  acceptInvitation(): void {
    const game = this.state();
    this.dismissInvitation();
    this.panelOpen.set(true); this.browsing.set(false);
    if (game && this.ready() && game.status === 'lobby' && !game.playerIds.includes(this.localUserId)
      && game.playerIds.length < (game.kind === 'trivia' ? 12 : 2)) {
      this.act({type:'join',gameId:game.id,expectedRevision:game.revision});
    }
  }
  dismissInvitation(): void {
    this.dismissedInvitationId = this.state()?.id ?? '';
    this.clearInvitationTimers(); this.invitationVisible.set(false);
  }
  private setGameState(state: CallGameState | null): void {
    this.state.set(state); this.updateInvitation();
  }
  private canInvite(): boolean {
    const game = this.state();
    return !!this.callId && !!game && this.ready() && game.status === 'lobby' && !this.panelOpen()
      && !game.playerIds.includes(this.localUserId) && game.playerIds.length < (game.kind === 'trivia' ? 12 : 2)
      && this.dismissedInvitationId !== game.id;
  }
  private updateInvitation(): void {
    const game = this.state();
    if (!this.canInvite()) { this.clearInvitationTimers(); this.invitationVisible.set(false); return; }
    if (!game || this.invitationGameId === game.id) return;
    this.clearInvitationTimers(); this.invitationGameId = game.id;
    const callId = this.callId, local = this.localUserId, id = game.id;
    const current = () => this.callId === callId && this.localUserId === local && this.state()?.id === id && this.canInvite();
    const later = (callback: () => void, delay: number) => {
      const timer = setTimeout(() => { this.invitationTimers.delete(timer); callback(); },delay);
      this.invitationTimers.add(timer);
    };
    this.invitationVisible.set(true);
    later(() => this.invitationVisible.set(false),6500);
    // One quiet reminder, only while the same lobby still has a free place.
    later(() => {
      if (!current()) return;
      this.invitationVisible.set(true);
      later(() => this.invitationVisible.set(false),6500);
    },45000);
  }
  private clearInvitationTimers(): void {
    for (const timer of this.invitationTimers) clearTimeout(timer);
    this.invitationTimers.clear();
  }

  private request(body: Record<string, unknown>): void {
    const localCancel = body['type'] === 'cancel' && this.coordinator === this.localUserId;
    if ((!this.ready() && !localCancel) || !this.coordinator || !this.users.includes(this.localUserId)) {
      this.error.set('Espera a que la llamada conecte con otro participante.'); return;
    }
    const request = { ...body, requestId: crypto.randomUUID() };
    if (this.coordinator === this.localUserId) this.receive({ senderUserId: this.localUserId, body: request });
    else this.send(request, [this.coordinator]);
  }

  private receive({ senderUserId, body }: CallGamePacket): void {
    if (!this.callId || !this.users.includes(senderUserId)) return;
    if (!this.engine && (this.enginePending || body['type'] === 'create' || body['type'] === 'action' || (body['type'] === 'state' && body['state'] != null))) {
      const epoch = this.epoch;
      void this.loadEngine().then(() => { if (epoch === this.epoch) this.receive({ senderUserId, body }); })
        .catch(() => { if (epoch === this.epoch) this.error.set('No se pudo cargar el juego. Revisa tu conexión y vuelve a intentarlo.'); });
      return;
    }
    if (body['type'] === 'state') {
      if (senderUserId !== this.coordinator || !this.validState(body['state'])) return;
      const next = body['state'] as CallGameState | null;
      const current = this.state();
      if (current && next?.id === current.id && next.revision < current.revision) return;
      this.setGameState(next);
      this.error.set('');
      return;
    }
    if (body['type'] === 'error') {
      if (senderUserId === this.coordinator && typeof body['message'] === 'string') this.error.set(body['message'].slice(0, 180));
      return;
    }
    if (this.coordinator !== this.localUserId) return;
    if (body['type'] === 'sync') { this.broadcast([senderUserId]); return; }
    const requestId = body['requestId'];
    if (typeof requestId !== 'string' || requestId.length > 80 || this.requests.has(senderUserId + ':' + requestId)) return;
    this.requests.add(senderUserId + ':' + requestId);
    if (this.requests.size > 512) this.requests.delete(this.requests.values().next().value!);
    const current = this.state();
    if (body['type'] === 'cancel') {
      // Only the creator can end this exact game, including an empty lobby.
      if (current && current.id === body['gameId'] && current.hostUserId === senderUserId) {
        this.setGameState(null);
        this.broadcast();
      }
      return;
    }
    if (body['type'] === 'create') {
      if (!KINDS.includes(String(body['kind']))) return;
      if (current && current.status !== 'finished') { this.reject(senderUserId, 'Ya hay una partida disponible. Únete desde Juegos.'); return; }
      this.setGameState(this.engine!.createCallGame(body['kind'] as CallGameKind, crypto.randomUUID(), senderUserId));
      this.broadcast();
      return;
    }
    if (body['type'] !== 'action' || !current || !this.validAction(body['action'])) return;
    const result = this.engine!.applyCallGameAction(current, senderUserId, body['action'] as CallGameAction);
    if (!result.accepted) {
      this.reject(senderUserId, result.error || 'El movimiento ya cambió. Revisa la partida e intenta de nuevo.');
      this.broadcast([senderUserId]);
      return;
    }
    const leaving = (body['action'] as CallGameAction).type === 'leave';
    this.setGameState(leaving && result.state.playerIds.length < 2 ? null : result.state);
    this.broadcast();
  }

  private broadcast(targets = this.transport.connectedPeers()): void {
    if (targets.length) this.send({ type: 'state', state: this.state() }, targets);
  }

  private reject(userId: string, message: string): void {
    if (userId === this.localUserId) this.error.set(message);
    else this.send({ type: 'error', message }, [userId]);
  }

  private send(body: Record<string, unknown>, targets: string[]): void {
    const callId = this.callId;
    void this.transport.send(body, targets).catch(error => {
      if (this.callId === callId) this.error.set(error instanceof Error ? error.message : 'No se pudo enviar el movimiento.');
    });
  }

  private validAction(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const action = value as Record<string, unknown>;
    if (typeof action['gameId'] !== 'string' || !Number.isSafeInteger(action['expectedRevision'])) return false;
    switch (action['type']) {
      case 'join': case 'start': case 'rematch': case 'leave': return true;
      case 'move': return Number.isInteger(action['index']) && Number(action['index']) >= 0 && Number(action['index']) < 64;
      case 'answer': return Number.isInteger(action['optionIndex']) && Number(action['optionIndex']) >= 0 && Number(action['optionIndex']) < 8;
      default: return false;
    }
  }

  private validState(value: unknown): boolean {
    if (value === null) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const s = value as CallGameState;
    return typeof s.id === 'string' && s.id.length <= 80 && KINDS.includes(s.kind) &&
      this.users.includes(s.hostUserId) && Array.isArray(s.playerIds) && s.playerIds.length <= 12 &&
      s.playerIds.every(id => this.users.includes(id)) && new Set(s.playerIds).size === s.playerIds.length &&
      ['lobby', 'playing', 'finished'].includes(s.status) && Number.isSafeInteger(s.revision) && s.revision >= 0 &&
      Number.isSafeInteger(s.round) && Array.isArray(s.board) && s.board.length === this.engine!.callGameBoardSize(s.kind) &&
      s.board.every(cell => cell === null || s.playerIds.includes(cell)) &&
      (s.turnUserId === null || s.playerIds.includes(s.turnUserId)) &&
      (s.winnerId === null || s.playerIds.includes(s.winnerId)) && typeof s.draw === 'boolean' &&
      s.scores !== null && typeof s.scores === 'object' && !Array.isArray(s.scores) &&
      Object.entries(s.scores).length <= 12 && Object.entries(s.scores).every(([id, score]) => s.playerIds.includes(id) && Number.isSafeInteger(score) && score >= 0) &&
      Array.isArray(s.answeredPlayerIds) && s.answeredPlayerIds.length <= 12 && s.answeredPlayerIds.every(id => s.playerIds.includes(id)) &&
      Number.isSafeInteger(s.questionIndex) && (s.question === null ||
        (typeof s.question?.prompt === 'string' && s.question.prompt.length < 300 && Array.isArray(s.question.options) &&
          s.question.options.length <= 8 && s.question.options.every(option => typeof option === 'string' && option.length < 150)));
  }
}
