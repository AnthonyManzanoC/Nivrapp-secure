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

  it('ignores only legacy devices without a published identity and preserves the comparison code', async () => {
    const alice = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    const legacy = directory('alice', [{ id: 'legacy-null', x: coordinate('C'), y: coordinate('D') }]).devices[0];
    const mixed = { ...alice, devices: [
      ...alice.devices,
      { ...legacy, deviceId: 'legacy-null', keyBundle: { ...legacy.keyBundle, identityKey: null } },
      { ...legacy, deviceId: 'legacy-empty', keyBundle: { ...legacy.keyBundle, identityKey: '' } },
      { ...legacy, deviceId: 'legacy-space', keyBundle: { ...legacy.keyBundle, identityKey: '  \n  ' } },
    ] };
    const bob = directory('bob', [{ id: 'phone', x: coordinate('C'), y: coordinate('D') }]);
    expect((await deriveDirectoryFingerprint(mixed)).digest).toBe((await deriveDirectoryFingerprint(alice)).digest);
    expect((await deriveDirectoryFingerprint(mixed)).deviceIds).toEqual(['phone']);
    expect((await deriveUnverifiedSafetyNumber(mixed, bob)).display).toBe((await deriveUnverifiedSafetyNumber(alice, bob)).display);
    await expectAsync(deriveDirectoryFingerprint({ ...mixed, devices: mixed.devices.slice(1) })).toBeRejected();
  });

  it('does not accept a malformed nonempty or private identity alongside valid devices', async () => {
    const valid = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    const extra = { ...valid.devices[0], deviceId: 'extra', keyBundle: { ...valid.devices[0].keyBundle } };
    for (const invalid of ['malformed', 'null', '{}', JSON.stringify({ ...JSON.parse(extra.keyBundle.identityKey!), d: coordinate('D') })]) {
      extra.keyBundle.identityKey = invalid;
      await expectAsync(deriveDirectoryFingerprint({ ...valid, devices: [...valid.devices, extra] })).toBeRejected();
    }
  });

  it('rejects duplicate device IDs even when one duplicate has no published key', async () => {
    const valid = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    const duplicate = { ...valid.devices[0], keyBundle: { ...valid.devices[0].keyBundle, identityKey: null } };
    await expectAsync(deriveDirectoryFingerprint({ ...valid, devices: [...valid.devices, duplicate] })).toBeRejected();
  });

  it('ignores JWK serialization metadata but changes for real published device additions and removals', async () => {
    const first = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    const metadata = directory('alice', [{ id: 'phone', x: coordinate('A'), y: coordinate('B') }]);
    metadata.devices[0].keyBundle.identityKey = JSON.stringify({ key_ops: ['deriveKey'], ext: true, y: coordinate('B'), x: coordinate('A'), crv: 'P-256', kty: 'EC' });
    expect((await deriveDirectoryFingerprint(metadata)).digest).toBe((await deriveDirectoryFingerprint(first)).digest);
    const added = directory('alice', [
      { id: 'phone', x: coordinate('A'), y: coordinate('B') },
      { id: 'new-pc', x: coordinate('C'), y: coordinate('D') },
    ]);
    expect((await deriveDirectoryFingerprint(added)).digest).not.toBe((await deriveDirectoryFingerprint(first)).digest);
    expect((await deriveDirectoryFingerprint({ ...added, devices: added.devices.slice(1) })).digest).not.toBe((await deriveDirectoryFingerprint(added)).digest);
  });
});
