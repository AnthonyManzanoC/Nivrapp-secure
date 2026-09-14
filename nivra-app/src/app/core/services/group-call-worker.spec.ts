import { BaseKeyProvider, createKeyMaterialFromBuffer } from 'livekit-client';

describe('packaged LiveKit encryption worker', () => {
  const workers: Worker[] = [];
  afterEach(() => { workers.splice(0).forEach(worker => worker.terminate()); });
  async function request(worker: Worker, message: unknown, expected: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error('Encryption worker timed out')); }, 3_000);
      const cleanup = () => { clearTimeout(timeout); worker.removeEventListener('message', receive); worker.removeEventListener('error', fail); };
      const fail = () => { cleanup(); reject(new Error('Encryption worker failed to load')); };
      const receive = (event: MessageEvent) => {
        if (event.data?.kind === 'error') { cleanup(); reject(new Error('Ciphertext was rejected')); }
        else if (event.data?.kind === expected) { cleanup(); resolve(event.data.data); }
      };
      worker.addEventListener('message', receive); worker.addEventListener('error', fail); worker.postMessage(message);
    });
  }
  async function configured(raw: ArrayBuffer) {
    const worker = new Worker(new URL('/assets/crypto/nivra-e2ee.worker.js', location.origin));
    workers.push(worker);
    await request(worker, { kind: 'init', data: { keyProviderOptions: new BaseKeyProvider({ sharedKey: false, keySize: 256, keyringSize: 1, ratchetWindowSize: 0 }).getOptions(), loglevel: 'silent' } }, 'initAck');
    worker.postMessage({ kind: 'setKey', data: { key: await createKeyMaterialFromBuffer(raw), participantIdentity: 'alice', keyIndex: 0, updateCurrentKeyIndex: true, isPublisher: true } });
    await request(worker, { kind: 'enable', data: { enabled: true, participantIdentity: 'alice' } }, 'enable');
    return worker;
  }
  it('loads the shipped worker and encrypts data that only the matching publisher key decrypts', async () => {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const sender = await configured(raw.slice().buffer);
    const receiver = await configured(raw.slice().buffer);
    const plaintext = new TextEncoder().encode('local encryption regression fixture');
    const packet = await request(sender, { kind: 'encryptDataRequest', data: { uuid: 'encrypt', payload: plaintext, participantIdentity: 'alice' } }, 'encryptDataResponse');
    expect([...packet.payload]).not.toEqual([...plaintext]);
    const opened = await request(receiver, { kind: 'decryptDataRequest', data: { ...packet, uuid: 'decrypt', participantIdentity: 'alice' } }, 'decryptDataResponse');
    expect([...opened.payload]).toEqual([...plaintext]);
    packet.payload[0] ^= 1;
    await expectAsync(request(receiver, { kind: 'decryptDataRequest', data: { ...packet, uuid: 'tamper', participantIdentity: 'alice' } }, 'decryptDataResponse')).toBeRejectedWithError('Ciphertext was rejected');
    raw.fill(0);
  });
});
