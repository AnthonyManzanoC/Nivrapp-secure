import type { AuthSession, CallSignalEvent, PublicKeyDirectory, RecipientCipherRequest } from '../models/nivra.models';
import type { CryptoService } from './crypto.service';

/** Strict decoder for media key exchange. Legacy plaintext signaling is intentionally not accepted. */
export async function decodeAuthenticatedMediaKeySignal(
  signal: CallSignalEvent,
  directory: PublicKeyDirectory | null,
  session: AuthSession | null,
  cryptography: Pick<CryptoService, 'jsonFromBase64Url' | 'currentKeyMaterial' | 'decryptEnvelope' | 'parsePublicJwk'>,
): Promise<unknown | null> {
  try {
    if (!session || !directory || directory.userId !== signal.fromUserId || !signal.fromDeviceId || !signal.fromClientSessionId ||
        !['media-key-request', 'media-key', 'media-key-ready'].includes(signal.signalType)) return null;
    const raw = signal.payloadCiphertext ?? '';
    if (!raw || raw.length > 256_000) return null;
    const envelope = (raw.startsWith('{') ? JSON.parse(raw) : cryptography.jsonFromBase64Url(raw)) as {
      v?: number; type?: string; recipients?: RecipientCipherRequest[];
    };
    if (envelope.v !== 2 || envelope.type !== 'nivra-call-signal' || !Array.isArray(envelope.recipients)) return null;
    const recipient = envelope.recipients.find(item => item.userId === session.user.id && item.deviceId === session.device.id);
    if (!recipient?.header || !recipient.ciphertext) return null;
    const header = JSON.parse(recipient.header) as { v?: number; alg?: string; senderPublicKey?: JsonWebKey };
    const expectedDevice = directory.devices.find(device => device.deviceId === signal.fromDeviceId);
    const expected = cryptography.parsePublicJwk(expectedDevice?.keyBundle?.identityKey);
    const presented = header.senderPublicKey;
    if (header.v !== 1 || header.alg !== 'ECDH-P256-A256GCM' || !expected || !presented ||
        expected.kty !== 'EC' || expected.crv !== 'P-256' || presented.kty !== expected.kty || presented.crv !== expected.crv ||
        !expected.x || !expected.y || presented.x !== expected.x || presented.y !== expected.y) return null;
    const keys = await cryptography.currentKeyMaterial(session.user.alias, session.device.id);
    const decoded = await cryptography.decryptEnvelope<{
      type?: string; sourceDeviceId?: string; sourceSessionId?: string; payload?: unknown;
    }>(keys, recipient.header, recipient.ciphertext);
    if (decoded.type !== signal.signalType || decoded.sourceDeviceId !== signal.fromDeviceId || decoded.sourceSessionId !== signal.fromClientSessionId) return null;
    return decoded.payload ?? null;
  } catch { return null; }
}
