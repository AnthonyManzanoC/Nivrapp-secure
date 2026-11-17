export const MAX_MESSAGE_SCHEDULE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
export const MIN_MESSAGE_SCHEDULE_DELAY_MS = 30_000;

export function scheduledMessageTime(value: number, now = Date.now()): string {
  if (!Number.isFinite(value) || value < now + MIN_MESSAGE_SCHEDULE_DELAY_MS || value > now + MAX_MESSAGE_SCHEDULE_DELAY_MS) {
    throw Error('Elige una hora entre 30 segundos y 30 días a partir de ahora.');
  }
  return new Date(value).toISOString();
}

export function localScheduleInput(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Reject invalid dates and DST gaps instead of silently choosing a different wall time. */
export function parseLocalScheduleInput(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw Error('Elige una fecha y hora válidas.');
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp) || localScheduleInput(timestamp) !== value) throw Error('Esa hora no existe en tu zona horaria. Elige otra.');
  return timestamp;
}
