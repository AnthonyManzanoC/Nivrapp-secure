/** Pure host reducer. The transport must authenticate senders as current call participants. */
export const CALL_GAME_KINDS = ['tic-tac-toe', 'connect-four', 'trivia', 'gomoku', 'take-away', 'reversi', 'hex'] as const;
export type CallGameKind = typeof CALL_GAME_KINDS[number];
export interface CallGameQuestion { prompt: string; options: string[]; }
export interface CallGameState {
  id: string;
  kind: CallGameKind;
  hostUserId: string;
  playerIds: string[];
  status: 'lobby' | 'playing' | 'finished';
  revision: number;
  round: number;
  board: Array<string | null>;
  turnUserId: string | null;
  winnerId: string | null;
  draw: boolean;
  scores: Record<string, number>;
  questionIndex: number;
  question: CallGameQuestion | null;
  answeredPlayerIds: string[];
}
interface ActionVersion { gameId: string; expectedRevision: number; }
export type CallGameAction = ActionVersion & (
  { type: 'join' | 'start' | 'rematch' | 'leave' } |
  { type: 'move'; index: number } |
  { type: 'answer'; optionIndex: number }
);
export interface CallGameResult { accepted: boolean; state: CallGameState; error?: string; }
export const TRIVIA_QUESTION_COUNT = 5;

export function createCallGame(kind: CallGameKind, id: string, hostUserId: string): CallGameState {
  if (!CALL_GAME_KINDS.includes(kind) || !id || !hostUserId) { throw new Error('Partida no válida.'); }
  return {
    id, kind, hostUserId, playerIds: [hostUserId], status: 'lobby', revision: 0, round: 1,
    board: Array<string | null>(callGameBoardSize(kind)).fill(null),
    turnUserId: null, winnerId: null, draw: false, scores: { [hostUserId]: 0 },
    questionIndex: 0, question: null, answeredPlayerIds: [],
  };
}

export function applyCallGameAction(state: CallGameState, senderUserId: string, action: CallGameAction): CallGameResult {
  const reject = (error: string): CallGameResult => ({ accepted: false, state, error });
  if (!senderUserId || !action || action.gameId !== state.id) { return reject('La partida no está disponible.'); }
  if (!Number.isSafeInteger(action.expectedRevision) || action.expectedRevision !== state.revision) {
    return reject('La partida cambió. Espera la actualización y vuelve a intentar.');
  }
  const next: CallGameState = {
    ...state, playerIds: [...state.playerIds], board: [...state.board], scores: { ...state.scores },
    answeredPlayerIds: [...state.answeredPlayerIds],
    question: state.question ? { ...state.question, options: [...state.question.options] } : null,
  };
  const accept = (): CallGameResult => {
    next.revision += 1;
    return { accepted: true, state: next };
  };
  const joined = state.playerIds.includes(senderUserId);
  if (action.type === 'join') {
    if (state.status !== 'lobby') { return reject('La partida ya comenzó. Puedes verla y jugar la próxima.'); }
    if (joined) { return reject('Ya estás en esta partida.'); }
    if (state.playerIds.length >= (state.kind === 'trivia' ? 12 : 2)) { return reject('Los puestos están completos. Puedes seguir como espectador.'); }
    next.playerIds.push(senderUserId);
    next.scores[senderUserId] = 0;
    return accept();
  }
  if (action.type === 'leave') {
    if (!joined) { return reject('No estás jugando en esta partida.'); }
    if (senderUserId === state.hostUserId) { return reject('El anfitrión debe cerrar la partida desde la llamada.'); }
    next.playerIds = next.playerIds.filter((id) => id !== senderUserId);
    next.answeredPlayerIds = next.answeredPlayerIds.filter((id) => id !== senderUserId);
    delete next.scores[senderUserId];
    if (state.status === 'playing') {
      if (state.kind !== 'trivia' || next.playerIds.length < 2) {
        finishGame(next, next.playerIds[0] ?? null);
      } else if (next.answeredPlayerIds.length === next.playerIds.length) {
        advanceTrivia(next);
      }
    }
    return accept();
  }
  if (action.type === 'start' || action.type === 'rematch') {
    if (senderUserId !== state.hostUserId) { return reject('Sólo el anfitrión puede iniciar la ronda.'); }
    if (action.type === 'rematch') {
      if (state.status !== 'finished') { return reject('La ronda aún no ha terminado.'); }
      next.round += 1;
      next.status = 'lobby';
      resetRound(next);
      return accept();
    }
    if (state.status !== 'lobby') { return reject('La ronda ya comenzó.'); }
    if (state.playerIds.length < 2) { return reject('Falta otra persona para comenzar.'); }
    resetRound(next);
    next.status = 'playing';
    if (next.kind === 'reversi') {
      next.board[14] = next.board[21] = next.playerIds[0];
      next.board[15] = next.board[20] = next.playerIds[1];
    }
    if (state.kind === 'trivia') {
      next.question = triviaChallenge(next).question;
    } else {
      next.turnUserId = next.playerIds[(next.round - 1) % next.playerIds.length];
    }
    return accept();
  }
  if (state.status !== 'playing') { return reject('La ronda no está en juego.'); }
  if (!joined) { return reject('Estás viendo la partida como espectador.'); }
  if (action.type === 'answer') {
    if (state.kind !== 'trivia' || !state.question) { return reject('Esta partida no tiene preguntas.'); }
    if (!Number.isInteger(action.optionIndex) || action.optionIndex < 0 || action.optionIndex >= state.question.options.length) {
      return reject('Selecciona una respuesta válida.');
    }
    if (state.answeredPlayerIds.includes(senderUserId)) { return reject('Ya respondiste esta pregunta.'); }
    if (action.optionIndex === triviaChallenge(state).correctIndex) { next.scores[senderUserId] += 10; }
    next.answeredPlayerIds.push(senderUserId);
    if (next.answeredPlayerIds.length === next.playerIds.length) { advanceTrivia(next); }
    return accept();
  }
  if (action.type !== 'move') { return reject('Jugada no válida.'); }
  if (state.kind === 'trivia') { return reject('Elige una respuesta para continuar.'); }
  if (state.turnUserId !== senderUserId) { return reject('Es el turno de otra persona.'); }
  if (state.kind === 'reversi' || state.kind === 'hex') {
    if (!Number.isInteger(action.index) || action.index < 0 || action.index >= state.board.length || state.board[action.index] !== null) return reject('Selecciona una casilla libre.');
    const rival = state.playerIds.find(id => id !== senderUserId)!;
    if (state.kind === 'reversi') {
      const flips = reversiFlips(state.board, action.index, senderUserId, rival);
      if (!flips.length) return reject('Esta jugada debe encerrar al menos una ficha rival.');
      next.board[action.index] = senderUserId;
      flips.forEach(index => next.board[index] = senderUserId);
      const canMove = (id: string, other: string) => next.board.some((cell, index) => cell === null && reversiFlips(next.board, index, id, other).length > 0);
      if (canMove(rival, senderUserId)) next.turnUserId = rival;
      else if (canMove(senderUserId, rival)) next.turnUserId = senderUserId;
      else {
        const mine = next.board.filter(cell => cell === senderUserId).length;
        const theirs = next.board.filter(cell => cell === rival).length;
        const winner = mine === theirs ? null : mine > theirs ? senderUserId : rival;
        finishGame(next, winner);
        if (winner) next.scores[winner]++;
      }
    } else {
      next.board[action.index] = senderUserId;
      if (hexConnected(next.board, senderUserId, senderUserId === next.playerIds[0])) {
        finishGame(next, senderUserId); next.scores[senderUserId]++;
      } else next.turnUserId = rival;
    }
    return accept();
  }
  if (state.kind === 'take-away') {
    const remaining = state.board.filter(cell => cell === null).length;
    if (!Number.isInteger(action.index) || action.index < 1 || action.index > 3 || action.index > remaining) return reject('Retira entre una y tres fichas disponibles.');
    let count = action.index;
    for (let i = 0; i < next.board.length && count > 0; i++) if (next.board[i] === null) { next.board[i] = senderUserId; count--; }
    if (remaining === action.index) { finishGame(next, senderUserId); next.scores[senderUserId]++; }
    else next.turnUserId = next.playerIds.find(id => id !== senderUserId) ?? null;
    return accept();
  }
  const columns = state.kind === 'gomoku' ? 8 : state.kind === 'tic-tac-toe' ? 3 : 7;
  const rows = state.kind === 'gomoku' ? 8 : state.kind === 'tic-tac-toe' ? 3 : 6;
  if (!Number.isInteger(action.index) || action.index < 0 || action.index >= (state.kind === 'gomoku' ? 64 : state.kind === 'tic-tac-toe' ? 9 : 7)) {
    return reject('Selecciona una casilla válida.');
  }
  let position = action.index;
  if (state.kind === 'connect-four') {
    position = -1;
    for (let row = rows - 1; row >= 0; row--) {
      const candidate = row * columns + action.index;
      if (state.board[candidate] === null) { position = candidate; break; }
    }
    if (position === -1) { return reject('Esa columna está llena.'); }
  }
  if (state.board[position] !== null) { return reject('Esa casilla está ocupada.'); }
  next.board[position] = senderUserId;
  if (hasLine(next.board, position, rows, columns, state.kind === 'gomoku' ? 5 : state.kind === 'tic-tac-toe' ? 3 : 4)) {
    finishGame(next, senderUserId);
    next.scores[senderUserId] += 1;
  } else if (next.board.every((cell) => cell !== null)) {
    finishGame(next, null);
  } else {
    next.turnUserId = next.playerIds.find((id) => id !== senderUserId) ?? null;
  }
  return accept();
}

function resetRound(state: CallGameState): void {
  state.board.fill(null);
  state.turnUserId = null;
  state.winnerId = null;
  state.draw = false;
  state.question = null;
  state.questionIndex = 0;
  state.answeredPlayerIds = [];
  state.scores = Object.fromEntries(state.playerIds.map((id) => [id, 0]));
}

export function callGameBoardSize(kind: CallGameKind): number {
  return ({'tic-tac-toe':9,'connect-four':42,gomoku:64,'take-away':21,trivia:0,reversi:36,hex:25})[kind];
}

export function reversiFlips(board: Array<string | null>, position: number, player: string, rival: string): number[] {
  if (position < 0 || position >= 36 || board[position] !== null) return [];
  const result: number[] = [];
  for (const [dr, dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
    const line: number[] = [];
    let row = Math.floor(position / 6) + dr, col = position % 6 + dc;
    while (row >= 0 && row < 6 && col >= 0 && col < 6 && board[row * 6 + col] === rival) {
      line.push(row * 6 + col); row += dr; col += dc;
    }
    if (line.length && row >= 0 && row < 6 && col >= 0 && col < 6 && board[row * 6 + col] === player) result.push(...line);
  }
  return result;
}

function hexConnected(board: Array<string | null>, player: string, vertical: boolean): boolean {
  const seen = new Set<number>(), pending: number[] = [];
  for (let i = 0; i < 5; i++) { const cell = vertical ? i : i * 5; if (board[cell] === player) pending.push(cell); }
  while (pending.length) {
    const cell = pending.pop()!;
    if (seen.has(cell)) continue;
    seen.add(cell);
    const row = Math.floor(cell / 5), col = cell % 5;
    if (vertical ? row === 4 : col === 4) return true;
    for (const [dr, dc] of [[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0]]) {
      const r = row + dr, c = col + dc, index = r * 5 + c;
      if (r >= 0 && r < 5 && c >= 0 && c < 5 && board[index] === player && !seen.has(index)) pending.push(index);
    }
  }
  return false;
}

function finishGame(state: CallGameState, winnerId: string | null): void {
  state.status = 'finished';
  state.winnerId = winnerId;
  state.draw = winnerId === null;
  state.turnUserId = null;
}

function advanceTrivia(state: CallGameState): void {
  if (state.questionIndex + 1 >= TRIVIA_QUESTION_COUNT) {
    const highScore = Math.max(...state.playerIds.map((id) => state.scores[id] || 0));
    const winners = state.playerIds.filter((id) => state.scores[id] === highScore);
    finishGame(state, winners.length === 1 ? winners[0] : null);
    return;
  }
  state.questionIndex += 1;
  state.question = triviaChallenge(state).question;
  state.answeredPlayerIds = [];
}

/** Original arithmetic questions; deterministic on the host, with no answer in the public snapshot. */
function triviaChallenge(state: Pick<CallGameState, 'id' | 'round' | 'questionIndex'>): { question: CallGameQuestion; correctIndex: number } {
  let seed = 2166136261;
  for (const char of `${state.id}:${state.round}:${state.questionIndex}`) {
    seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  const a = 3 + seed % 18;
  const b = 2 + (seed >>> 6) % 12;
  const operation = (seed >>> 12) % 3;
  const answer = operation === 0 ? a + b : operation === 1 ? a * b : a + b - b;
  const prompt = operation === 0 ? `${a} + ${b} = ?` : operation === 1 ? `${a} × ${b} = ?` : `${a + b} − ${b} = ?`;
  const correctIndex = (seed >>> 18) % 4;
  const options = [answer, answer - 2, answer + 1, answer + 3].map(String);
  [options[0], options[correctIndex]] = [options[correctIndex], options[0]];
  return { question: { prompt, options }, correctIndex };
}

function hasLine(board: Array<string | null>, position: number, rows: number, columns: number, required: number): boolean {
  const value = board[position];
  const originRow = Math.floor(position / columns);
  const originColumn = position % columns;
  return [[0, 1], [1, 0], [1, 1], [1, -1]].some(([deltaRow, deltaColumn]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let row = originRow + sign * deltaRow;
      let column = originColumn + sign * deltaColumn;
      while (row >= 0 && row < rows && column >= 0 && column < columns && board[row * columns + column] === value) {
        count += 1;
        row += sign * deltaRow;
        column += sign * deltaColumn;
      }
    }
    return count >= required;
  });
}
