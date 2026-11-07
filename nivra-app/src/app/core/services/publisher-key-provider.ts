import { BaseKeyProvider, createKeyMaterialFromBuffer } from 'livekit-client';
export class PublisherKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, keySize: 256, keyringSize: 1, ratchetWindowSize: 0, failureTolerance: -1 });
  }
  async install(userId: string, rawKey: Uint8Array): Promise<void> {
    const key = await createKeyMaterialFromBuffer(rawKey.slice().buffer);
    this.onSetEncryptionKey(key, userId, 0);
  }
}
