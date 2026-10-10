import { ChatMessageVm } from '../models/nivra.models';
import { uniqueCallSummaries, validatedCallSummary } from './call-summary.helpers';

describe('encrypted call summary presentation', () => {
  const message = (id: string, event = 'call-ended', callId = 'call-a', type = 'system-call') => ({
    id, conversationId: 'group', payload: { type, event, callId },
  } as unknown as ChatMessageVm);
  it('displays duplicate historical summaries only once without changing stored messages', () => {
    const stored = [message('a'), message('b')];
    expect(uniqueCallSummaries(stored).map(item => item.id)).toEqual(['a']);
    expect(stored.length).toBe(2);
  });
  it('keeps different calls and different final events distinct', () => {
    const stored = [message('a'), message('b', 'call-ended', 'call-b'), message('c', 'missed-call')];
    expect(uniqueCallSummaries(stored).length).toBe(3);
  });
  it('does not deduplicate ordinary text even if it contains a call identifier', () => {
    expect(uniqueCallSummaries([message('a', 'call-ended', 'call-a', 'text'), message('b', 'call-ended', 'call-a', 'text')]).length).toBe(2);
  });
  it('does not merge incomplete legacy summaries or calls from different chats', () => {
    const other = { ...message('b'), conversationId: 'other-group' };
    expect(uniqueCallSummaries([message('a'), other, message('c', 'call-ended', ''), message('d', 'call-ended', '')]).length).toBe(4);
  });
  const summary: any = {
    type: 'system-call', event: 'call-ended', callId: 'cal_test', conversationId: 'group', groupCall: true,
    callType: 'Video', durationMs: 60_000, startedAt: '2026-10-09T10:00:00Z', endedAt: '2026-10-09T10:01:00Z',
  };
  it('rejects text or control payloads hidden in a reserved call identifier', () => {
    for (const type of ['text', 'reaction', 'edit', 'delete', 'system']) {
      expect(validatedCallSummary('call-summary:cal_test:call-ended', { ...summary, type }, 'group')).toBeNull();
    }
  });
  it('binds the decrypted payload to the reserved call, event and conversation', () => {
    for (const changed of [{ callId: 'cal_other' }, { event: 'missed-call' }, { conversationId: 'other' }, { durationMs: NaN }, { callType: 'Text' }]) {
      expect(validatedCallSummary('call-summary:cal_test:call-ended', { ...summary, ...changed }, 'group')).toBeNull();
    }
  });
  it('rebuilds a valid summary without arbitrary title, caption, file or control fields', () => {
    const result = validatedCallSummary('call-summary:cal_test:call-ended', {
      ...summary, title: 'arbitrary message', text: 'arbitrary text', fileObjectId: 'fake-file', targetMessageId: 'victim',
    }, 'group')!;
    expect(result.title).toBe('Videollamada finalizada');
    expect(result.text).toBe('Duracion 1:00');
    expect(result['fileObjectId']).toBeUndefined();
    expect(result['targetMessageId']).toBeUndefined();
  });
});
