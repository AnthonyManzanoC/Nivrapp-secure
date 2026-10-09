/** Camera preferences must not exclude otherwise usable desktop/mobile cameras. */
export const CALL_CAMERA_PREFERENCES: MediaTrackConstraints = {
  facingMode: { ideal: 'user' },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export const CALL_CAMERA_FAILURE_MESSAGES = {
  permission: { key: 'CALLS.CAMERA_PERMISSION_ERROR', fallback: 'Permite el acceso a la cámara y vuelve a intentarlo. El audio continúa.' },
  missing: { key: 'CALLS.CAMERA_NOT_FOUND_ERROR', fallback: 'No se encontró una cámara. Conecta una cámara y vuelve a intentarlo; el audio continúa.' },
  unavailable: { key: 'CALLS.CAMERA_UNAVAILABLE_ERROR', fallback: 'No se pudo iniciar la cámara. Revisa los permisos del navegador y si otra aplicación la está usando; el audio continúa.' },
  unknown: { key: 'CALLS.CAMERA_UPGRADE_ERROR', fallback: 'No se pudo actualizar el video. El audio continúa; vuelve a intentarlo.' },
} as const;

export function cameraFailureMessage(error: unknown): string {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (['NotAllowedError', 'SecurityError', 'PermissionDeniedError'].includes(name)) return CALL_CAMERA_FAILURE_MESSAGES.permission.fallback;
  if (['NotFoundError', 'DevicesNotFoundError'].includes(name)) return CALL_CAMERA_FAILURE_MESSAGES.missing.fallback;
  if (canRetryCameraCapture(error)) return CALL_CAMERA_FAILURE_MESSAGES.unavailable.fallback;
  return CALL_CAMERA_FAILURE_MESSAGES.unknown.fallback;
}

export function canRetryCameraCapture(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return ['OverconstrainedError', 'ConstraintNotSatisfiedError', 'NotReadableError', 'TrackStartError', 'AbortError'].includes(name);
}

/** One compatibility retry; permission denials never trigger another capture request. */
export async function captureCallMedia(
  capture: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
  constraints: MediaStreamConstraints,
  isCurrent: () => boolean,
): Promise<MediaStream> {
  if (!isCurrent()) throw new DOMException('La llamada terminó.', 'AbortError');
  let stream: MediaStream;
  try {
    stream = await capture(constraints);
  } catch (error) {
    if (!constraints.video || constraints.video === true || !canRetryCameraCapture(error) || !isCurrent()) throw error;
    // Preserve the existing microphone by keeping audio:false during a voice→video upgrade.
    stream = await capture({ audio: constraints.audio ?? false, video: true });
  }
  if (!isCurrent()) {
    stream.getTracks().forEach(track => track.stop());
    throw new DOMException('La llamada terminó antes de activar el dispositivo.', 'AbortError');
  }
  return stream;
}
