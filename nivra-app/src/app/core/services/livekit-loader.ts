// Shared lazy boundary. A failed download may be retried after connectivity returns.
let pending: Promise<typeof import('livekit-client')> | undefined;
export function loadLiveKit(): Promise<typeof import('livekit-client')> {
  return pending ??= import('livekit-client').catch(error => { pending = undefined; throw error; });
}
