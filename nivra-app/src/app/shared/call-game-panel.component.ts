import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CallGameAction, CallGameKind, CallGameState, TRIVIA_QUESTION_COUNT } from '../core/games/call-game-engine';

@Component({
  selector: 'app-call-game-panel',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './call-game-panel.component.html',
  styleUrls: ['./call-game-panel.component.scss'],
})
export class CallGamePanelComponent {
  @Input() state: CallGameState | null = null;
  @Input() currentUserId = '';
  @Input() participants: Array<{ userId: string; label: string }> = [];
  @Input() transportReady = false;
  @Input() error = '';
  @Input() activeGameAvailable = false;
  @Output() resume = new EventEmitter<void>();
  @Output() create = new EventEmitter<CallGameKind>();
  @Output() action = new EventEmitter<CallGameAction>();
  @Output() closed = new EventEmitter<void>();
  @Output() catalogue = new EventEmitter<void>();
  readonly questionCount = TRIVIA_QUESTION_COUNT;
  readonly columns = [0, 1, 2, 3, 4, 5, 6];
  readonly choices: Array<{ kind: CallGameKind; title: string; symbol: string; description: string }> = [
    { kind: 'tic-tac-toe', title: '3 en raya', symbol: '× ○', description: 'Forma una línea antes que tu rival.' },
    { kind: 'connect-four', title: '4 en línea', symbol: '● ●', description: 'Deja caer fichas y conecta cuatro.' },
    { kind: 'trivia', title: 'Reto de cálculo', symbol: '+ ×', description: 'Cinco preguntas para jugar en grupo.' },
  ];

  label(userId: string | null): string {
    if (userId === this.currentUserId) { return 'Tú'; }
    return this.participants.find((person) => person.userId === userId)?.label || 'Participante';
  }

  title(): string { return this.choices.find((choice) => choice.kind === this.state?.kind)?.title || 'Juegos en llamada'; }
  isHost(): boolean { return this.state?.hostUserId === this.currentUserId; }
  hasJoined(): boolean { return this.state?.playerIds.includes(this.currentUserId) === true; }
  myTurn(): boolean { return this.state?.status === 'playing' && this.state.turnUserId === this.currentUserId; }
  hasAnswered(): boolean { return this.state?.answeredPlayerIds.includes(this.currentUserId) === true; }
  canJoin(): boolean {
    return this.state?.status === 'lobby' && !this.hasJoined() && this.state.playerIds.length < (this.state.kind === 'trivia' ? 12 : 2);
  }

  statusLabel(): string {
    const state = this.state;
    if (!state) { return ''; }
    if (state.status === 'finished') {
      if (state.draw) { return '¡Empate!'; }
      return state.winnerId === this.currentUserId ? '¡Ganaste la ronda!' : `${this.label(state.winnerId)} ganó la ronda`;
    }
    if (state.status === 'lobby') {
      return state.playerIds.length < 2 ? 'Esperando a otra persona de la llamada' : 'Todo listo. El anfitrión puede comenzar.';
    }
    if (!this.hasJoined()) { return 'Estás viendo la partida'; }
    if (state.kind === 'trivia') {
      return this.hasAnswered() ? 'Respuesta enviada. Esperando al grupo…' : 'Elige tu respuesta';
    }
    return this.myTurn() ? 'Tu turno' : `Turno de ${this.label(state.turnUserId)}`;
  }

  symbol(userId: string | null): string { return userId ? (userId === this.state?.playerIds[0] ? '×' : '○') : ''; }

  dispatch(type: 'join' | 'start' | 'rematch' | 'leave'): void {
    if (!this.state || !this.transportReady) { return; }
    this.action.emit({ type, gameId: this.state.id, expectedRevision: this.state.revision });
  }

  move(index: number): void {
    if (!this.state || !this.transportReady || !this.myTurn()) { return; }
    this.action.emit({ type: 'move', gameId: this.state.id, expectedRevision: this.state.revision, index });
  }

  answer(optionIndex: number): void {
    if (!this.state || !this.transportReady || !this.hasJoined() || this.hasAnswered() || this.state.status !== 'playing') { return; }
    this.action.emit({ type: 'answer', gameId: this.state.id, expectedRevision: this.state.revision, optionIndex });
  }
}
