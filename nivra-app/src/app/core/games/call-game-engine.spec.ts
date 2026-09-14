import { CallGameAction, CallGameKind, CallGameState, TRIVIA_QUESTION_COUNT, applyCallGameAction, createCallGame } from './call-game-engine';

type Proposal = { type: 'join' | 'start' | 'rematch' | 'leave' } | { type: 'move'; index: number } | { type: 'answer'; optionIndex: number };
const action = (state: CallGameState, proposal: Proposal): CallGameAction => ({ ...proposal, gameId: state.id, expectedRevision: state.revision });
function accepted(state: CallGameState, sender: string, proposal: Proposal): CallGameState {
  const result = applyCallGameAction(state, sender, action(state, proposal));
  expect(result.accepted).withContext(result.error || 'expected accepted action').toBeTrue();
  return result.state;
}
function playing(kind: CallGameKind, extraPlayers: string[] = []): CallGameState {
  let state = createCallGame(kind, 'game-one', 'host');
  for (const id of ['guest', ...extraPlayers]) { state = accepted(state, id, { type: 'join' }); }
  return accepted(state, 'host', { type: 'start' });
}
function moves(state: CallGameState, indices: number[]): CallGameState {
  for (const index of indices) { state = accepted(state, state.turnUserId!, { type: 'move', index }); }
  return state;
}
function correctAnswer(state: CallGameState): number {
  const match = state.question!.prompt.match(/(\d+) ([+×−]) (\d+)/)!;
  const a = Number(match[1]); const b = Number(match[3]);
  return state.question!.options.indexOf(String(match[2] === '+' ? a + b : match[2] === '×' ? a * b : a - b));
}

describe('authoritative call game rules', () => {
  it('requires a real second player and reserves start control for the creator', () => {
    const initial = createCallGame('tic-tac-toe', 'game-one', 'host');
    expect(initial.playerIds).toEqual(['host']);
    expect(applyCallGameAction(initial, 'host', action(initial, { type: 'start' })).accepted).toBeFalse();
    const joined = accepted(initial, 'guest', { type: 'join' });
    expect(applyCallGameAction(joined, 'guest', action(joined, { type: 'start' })).accepted).toBeFalse();
    expect(applyCallGameAction(joined, 'spectator', action(joined, { type: 'join' })).accepted).toBeFalse();
    expect(initial.playerIds).toEqual(['host']);
    expect(initial.revision).toBe(0);
  });

  it('rejects stale, cross-game, spectator and out-of-turn moves without changing state', () => {
    const state = playing('tic-tac-toe');
    const move = action(state, { type: 'move', index: 0 });
    for (const [sender, proposal] of [
      ['guest', move], ['spectator', move],
      ['host', { ...move, expectedRevision: 0 }], ['host', { ...move, gameId: 'other' }],
    ] as Array<[string, CallGameAction]>) {
      const result = applyCallGameAction(state, sender, proposal);
      expect(result.accepted).toBeFalse();
      expect(result.state).toBe(state);
    }
    expect(state.board.every((cell) => cell === null)).toBeTrue();
  });

  it('detects a three-in-a-row win and rejects moves after the round', () => {
    const initial = playing('tic-tac-toe');
    const state = moves(initial, [0, 3, 1, 4, 2]);
    expect(state.status).toBe('finished');
    expect(state.winnerId).toBe('host');
    expect(state.scores['host']).toBe(1);
    expect(initial.board.every((cell) => cell === null)).toBeTrue();
    expect(applyCallGameAction(state, 'guest', action(state, { type: 'move', index: 5 })).accepted).toBeFalse();
  });

  it('recognizes a full-board draw and never treats wrapped rows as a line', () => {
    const draw = moves(playing('tic-tac-toe'), [0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(draw.status).toBe('finished');
    expect(draw.draw).toBeTrue();
    expect(draw.winnerId).toBeNull();
    expect(moves(playing('tic-tac-toe'), [2, 0, 3, 8, 4]).status).toBe('playing');
  });

  it('applies gravity and detects four-in-a-row in every relevant direction', () => {
    for (const sequence of [[0, 1, 0, 1, 0, 1, 0], [0, 0, 1, 1, 2, 2, 3], [0, 1, 1, 2, 4, 2, 2, 3, 4, 3, 5, 3, 3]]) {
      const state = moves(playing('connect-four'), sequence);
      expect(state.status).toBe('finished');
      expect(state.winnerId).toBe('host');
      expect(state.board[35]).toBe('host');
    }
  });

  it('rejects full columns, occupied cells, fractional and out-of-range positions', () => {
    const fullColumn = moves(playing('connect-four'), [0, 0, 0, 0, 0, 0]);
    expect(applyCallGameAction(fullColumn, 'host', action(fullColumn, { type: 'move', index: 0 })).accepted).toBeFalse();
    for (const index of [-1, 7, 0.5, NaN, Infinity]) {
      expect(applyCallGameAction(fullColumn, 'host', action(fullColumn, { type: 'move', index })).accepted).toBeFalse();
    }
    const occupied = moves(playing('tic-tac-toe'), [0]);
    expect(applyCallGameAction(occupied, 'guest', action(occupied, { type: 'move', index: 0 })).accepted).toBeFalse();
  });

  it('scores each arithmetic answer once and advances only when the group answered', () => {
    let state = playing('trivia', ['third']);
    const first = state;
    const answer = correctAnswer(state);
    expect(answer).toBeGreaterThanOrEqual(0);
    state = accepted(state, 'host', { type: 'answer', optionIndex: answer });
    expect(state.scores['host']).toBe(10);
    expect(state.answeredPlayerIds).toEqual(['host']);
    expect(state.questionIndex).toBe(0);
    expect(applyCallGameAction(state, 'host', action(state, { type: 'answer', optionIndex: answer })).accepted).toBeFalse();
    state = accepted(state, 'guest', { type: 'answer', optionIndex: (answer + 1) % 4 });
    expect(state.scores['guest']).toBe(0);
    state = accepted(state, 'third', { type: 'answer', optionIndex: answer });
    expect(state.questionIndex).toBe(1);
    expect(state.answeredPlayerIds).toEqual([]);
    expect(Object.keys(state.question!)).toEqual(['prompt', 'options']);
    expect(first.scores['host']).toBe(0);
  });

  it('finishes five real trivia questions and calculates the winner', () => {
    let state = playing('trivia');
    for (let round = 0; round < TRIVIA_QUESTION_COUNT; round++) {
      const correct = correctAnswer(state);
      state = accepted(state, 'host', { type: 'answer', optionIndex: correct });
      state = accepted(state, 'guest', { type: 'answer', optionIndex: (correct + 1) % 4 });
    }
    expect(state.status).toBe('finished');
    expect(state.winnerId).toBe('host');
    expect(state.scores['host']).toBe(50);
    expect(state.scores['guest']).toBe(0);
  });

  it('handles a departing player without leaving trivia or a board waiting forever', () => {
    let state = playing('trivia', ['third']);
    const correct = correctAnswer(state);
    state = accepted(state, 'host', { type: 'answer', optionIndex: correct });
    state = accepted(state, 'guest', { type: 'answer', optionIndex: correct });
    state = accepted(state, 'third', { type: 'leave' });
    expect(state.playerIds).toEqual(['host', 'guest']);
    expect(state.questionIndex).toBe(1);
    const board = accepted(playing('connect-four'), 'guest', { type: 'leave' });
    expect(board.status).toBe('finished');
    expect(board.winnerId).toBe('host');
  });

  it('lets the host prepare a clean rematch and alternates the opening player', () => {
    const finished = moves(playing('tic-tac-toe'), [0, 3, 1, 4, 2]);
    expect(applyCallGameAction(finished, 'guest', action(finished, { type: 'rematch' })).accepted).toBeFalse();
    let next = accepted(finished, 'host', { type: 'rematch' });
    expect(next.status).toBe('lobby');
    expect(next.round).toBe(2);
    expect(next.board.every((cell) => cell === null)).toBeTrue();
    next = accepted(next, 'host', { type: 'start' });
    expect(next.turnUserId).toBe('guest');
  });
});
