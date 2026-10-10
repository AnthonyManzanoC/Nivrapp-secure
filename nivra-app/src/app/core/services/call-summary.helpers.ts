import { ChatMessageVm, ChatPayload } from '../models/nivra.models';

/** A reserved call ID can never carry text, controls or an arbitrary system title. */
export function validatedCallSummary(clientMessageId: string | undefined, payload: ChatPayload, conversationId: string): ChatPayload | null {
  if (!clientMessageId?.startsWith('call-summary:')) return payload;
  const match = /^call-summary:(cal_[A-Za-z0-9_]{1,60}):(call-ended|missed-call|call-rejected|call-failed)$/.exec(clientMessageId);
  const duration = payload['durationMs'];
  const group = payload.type === 'system-call';
  if (!match || !['call_log', 'system-call'].includes(payload.type) || payload['callId'] !== match[1] ||
      payload.event !== match[2] || payload['conversationId'] !== conversationId ||
      !['Voice', 'Video'].includes(String(payload['callType'])) || typeof duration !== 'number' ||
      !Number.isFinite(duration) || duration < 0 || duration > 365 * 24 * 60 * 60 * 1000 ||
      Boolean(payload['groupCall']) !== group || !Number.isFinite(Date.parse(String(payload['startedAt']))) ||
      !Number.isFinite(Date.parse(String(payload['endedAt'])))) return null;
  const event = match[2];
  const missed = event === 'missed-call';
  const title = event === 'call-rejected' ? 'Llamada rechazada'
    : event === 'call-failed' ? 'Llamada fallida'
    : missed ? (group ? (payload['callType'] === 'Video' ? 'Videollamada grupal perdida' : 'Llamada grupal perdida') : 'Llamada perdida')
    : group ? (payload['callType'] === 'Video' ? 'Videollamada finalizada' : 'Llamada grupal finalizada') : 'Llamada finalizada';
  const seconds = Math.round(duration / 1000);
  return {
    type: group ? 'system-call' : 'call_log', event, title,
    text: event === 'call-ended' ? `Duracion ${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, '0')}`
      : event === 'call-rejected' ? 'Rechazada' : event === 'call-failed' ? 'No se pudo conectar' : 'No hubo respuesta',
    status: missed ? 'missed' : event === 'call-rejected' ? 'rejected' : event === 'call-failed' ? 'failed' : 'ended',
    durationMs: duration, callId: match[1], callType: payload['callType'], conversationId, groupCall: group,
    initiatorUserId: typeof payload['initiatorUserId'] === 'string' ? payload['initiatorUserId'] : '',
    startedAt: payload['startedAt'], endedAt: payload['endedAt'],
  };
}

/** Keep existing encrypted history intact while displaying old duplicate logs once. */
export function uniqueCallSummaries(messages: ChatMessageVm[]): ChatMessageVm[] {
  const seen = new Set<string>();
  return messages.filter(message => {
    const payload = message.payload;
    if (!['call_log', 'system-call', 'system'].includes(payload.type) || !payload['callId'] ||
        !['call-ended', 'missed-call', 'call-rejected', 'call-failed'].includes(String(payload.event))) return true;
    const key = `${message.conversationId}:${payload['callId']}:${payload.event}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
