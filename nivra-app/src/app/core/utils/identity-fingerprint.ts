import type { PublicKeyDirectory } from '../models/nivra.models';

/**
 * A deterministic representation of the public device directory.  It is deliberately
 * not a verification state: a user must compare it out of band before an application
 * may call an identity verified.
 */
export const IDENTITY_DIRECTORY_PROTOCOL = 'nivra-directory-v1' as const;

export interface DirectoryFingerprint {
  protocol: typeof IDENTITY_DIRECTORY_PROTOCOL;
  userId: string;
  deviceIds: string[];
  digest: string;
  display: string;
}

export interface UnverifiedSafetyNumber {
  protocol: typeof IDENTITY_DIRECTORY_PROTOCOL;
  participants: [string, string];
  display: string;
}

interface CanonicalIdentityDirectory {
  userId: string;
  devices: Array<{ deviceId: string; x: string; y: string }>;
}

const BASE64_URL_P256_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Hashes the exact public-key directory returned by the service. A directory change
 * (new, revoked, or rotated device key) changes the result. It never records trust
 * locally and cannot establish identity without a separate authenticated comparison.
 */
export async function deriveDirectoryFingerprint(directory: PublicKeyDirectory): Promise<DirectoryFingerprint> {
  const canonical = canonicalizeDirectory(directory);
  const digest = await sha256Hex(JSON.stringify({ protocol: IDENTITY_DIRECTORY_PROTOCOL, ...canonical }));
  return {
    protocol: IDENTITY_DIRECTORY_PROTOCOL,
    userId: canonical.userId,
    deviceIds: canonical.devices.map((device) => device.deviceId),
    digest,
    display: groupHex(digest),
  };
}

/**
 * Produces a compare-only code for two directory snapshots. Both participants must
 * independently derive and compare it through a trusted, out-of-band channel (for
 * example, a QR scan performed in person). Calling this function does not verify a
 * contact and deliberately exposes no boolean such as `verified`.
 */
export async function deriveUnverifiedSafetyNumber(
  first: PublicKeyDirectory,
  second: PublicKeyDirectory,
): Promise<UnverifiedSafetyNumber> {
  const [left, right] = await Promise.all([deriveDirectoryFingerprint(first), deriveDirectoryFingerprint(second)]);
  if (left.userId === right.userId) {
    throw new Error('Se necesitan dos identidades distintas para comparar las llaves.');
  }
  const ordered = [left, right].sort((a, b) => compareCanonicalStrings(a.userId, b.userId));
  const digest = await sha256Hex(JSON.stringify({
    protocol: `${IDENTITY_DIRECTORY_PROTOCOL}:compare`,
    directories: ordered.map((directory) => ({ userId: directory.userId, digest: directory.digest })),
  }));
  return {
    protocol: IDENTITY_DIRECTORY_PROTOCOL,
    participants: [ordered[0].userId, ordered[1].userId],
    display: groupHex(digest),
  };
}

function canonicalizeDirectory(directory: PublicKeyDirectory): CanonicalIdentityDirectory {
  const userId = String(directory?.userId || '').trim();
  if (!userId || userId.length > 128) {
    throw new Error('El directorio no tiene una identidad válida.');
  }

  const seen = new Set<string>();
  const devices = (directory.devices ?? []).map((device) => {
    const deviceId = String(device?.deviceId || '').trim();
    const identity = parseP256IdentityKey(device?.keyBundle?.identityKey);
    if (!deviceId || deviceId.length > 128 || !identity || seen.has(deviceId)) {
      throw new Error('El directorio contiene una llave de dispositivo inválida.');
    }
    seen.add(deviceId);
    return { deviceId, ...identity };
  }).sort((left, right) => compareCanonicalStrings(left.deviceId, right.deviceId));

  if (!devices.length) {
    throw new Error('El directorio no contiene dispositivos confiables.');
  }
  return { userId, devices };
}

function parseP256IdentityKey(value: string | null | undefined): { x: string; y: string } | null {
  try {
    const key = JSON.parse(value || '') as Partial<JsonWebKey>;
    if (key.kty !== 'EC' || key.crv !== 'P-256' ||
        typeof key.x !== 'string' || typeof key.y !== 'string' ||
        !BASE64_URL_P256_COORDINATE.test(key.x) || !BASE64_URL_P256_COORDINATE.test(key.y)) {
      return null;
    }
    return { x: key.x, y: key.y };
  } catch {
    return null;
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}

function groupHex(value: string): string {
  return value.match(/.{1,4}/g)?.join(' ') ?? value;
}

/** Locale-independent ordering is required because both contacts derive the code. */
function compareCanonicalStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
