import type { PublicKeyDirectory } from '../models/nivra.models';
import { deriveDirectoryFingerprint, deriveUnverifiedSafetyNumber } from './identity-fingerprint';

const key = (x: string, y: string) => JSON.stringify({ kty: 'EC', crv: 'P-256', x, y });
const coordinate = (letter: string) => letter.repeat(43);

const directory = (userId: string, devices: Array<{ id: string; x: string; y: string }>): PublicKeyDirectory => ({
  userId,
  alias: userId,
  devices: devices.map((device) => ({
    deviceId: device.id,
    deviceName: device.id,
    keyBundle: { identityKey: key(device.x, device.y), signedPreKey: null, preKeySignature: null, oneTimePreKeys: [] },
    lastRotatedAt: '2026-09-13T00:00:00.000Z',
  })),
});

describe('identity directory fingerprints', () => {
  it('is stable when the service returns devices in a different order', async () => {
    const first = directory('alice', [
      { id: 'phone', x: coordinate('A'), y: coordinate('B') },
      { id: 'desktop', x: coordinate('C'), y: coordinate('D') },
    ]);
    const reordered = directory('alice', [
      { id: 'desktop', x: coordinate('C'), y: coordinate('D') },
      { id: 'phone', x: coordinate('A'), y: coordinate('B') },
    ]);

    const [left, right] = await Promise.all([deriveDirectoryFingerprint(first), deriveDirectoryFingerprint(reordered)]);
    expect(left.digest).toBe(right.digest);
    expect(left.display).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){15}$/);
  });

  it('changes when a device identity changes and is symmetric for two people', async () => {
    const alice = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    const replacedAlice = directory('alice', [{ id: 'phone', x: coordinate('E'), y: coordinate('B') }]);
    const bob = directory('bob', [{ id: 'phone', x: coordinate('C'), y: coordinate('D') }]);

    expect((await deriveDirectoryFingerprint(alice)).digest).not.toBe((await deriveDirectoryFingerprint(replacedAlice)).digest);
    expect((await deriveUnverifiedSafetyNumber(alice, bob)).display)
      .toBe((await deriveUnverifiedSafetyNumber(bob, alice)).display);
  });

  it('rejects malformed or empty directories instead of inventing a comparison code', async () => {
    await expectAsync(deriveDirectoryFingerprint(directory('alice', []))).toBeRejected();
    const malformed = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    malformed.devices[0].keyBundle.identityKey = '{"kty":"RSA"}';
    await expectAsync(deriveDirectoryFingerprint(malformed)).toBeRejected();
  });
});
