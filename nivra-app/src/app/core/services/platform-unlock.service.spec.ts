import { Capacitor } from '@capacitor/core';
import { AndroidBiometryStrength } from '@aparajita/capacitor-biometric-auth';
import { PlatformUnlockService } from './platform-unlock.service';

describe('platform user verification', () => {
  const account = 'platform-unlock-test-account';
  const other = 'platform-unlock-test-other';
  const context = { origin: 'https://nivra.example.test', rpId: 'nivra.example.test' };
  const encoder = new TextEncoder();
  const bytes = (value: Uint8Array) => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  const b64 = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  let service: PlatformUnlockService;
  let api: { create: jasmine.Spy; get: jasmine.Spy };
  let native: { checkBiometry: jasmine.Spy; authenticate: jasmine.Spy };
  let keys: CryptoKeyPair;
  let spki: ArrayBuffer;
  let userHandle: ArrayBuffer;
  let assertionCounter: number;
  let availability: jasmine.Spy;
  const credentialId = new Uint8Array([17, 28, 39, 40, 51, 62, 73, 84]);

  const clientData = (type: string, options: any, overrides = {}) => bytes(encoder.encode(JSON.stringify({
    type, challenge: b64(new Uint8Array(options.publicKey.challenge)), origin: context.origin, crossOrigin: false, ...overrides,
  })));

  async function authData(flags: number, counter: number, registration = false, rpId = context.rpId): Promise<Uint8Array> {
    const data = new Uint8Array(registration ? 55 + credentialId.length + 1 : 37);
    data.set(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(rpId))));
    data[32] = flags;
    new DataView(data.buffer).setUint32(33, counter, false);
    if (registration) {
      data[54] = credentialId.length;
      data.set(credentialId, 55);
      data[data.length - 1] = 0xa0; // Browser fixture supplies the decoded SPKI below.
    }
    return data;
  }

  async function registration(options: any, flags = 0x45, clientOverrides = {}): Promise<Credential> {
    userHandle = options.publicKey.user.id;
    const data = await authData(flags, 0, true);
    return { id: b64(credentialId), type: 'public-key', rawId: bytes(credentialId), authenticatorAttachment: 'platform', response: {
      clientDataJSON: clientData('webauthn.create', options, clientOverrides),
      getAuthenticatorData: () => bytes(data), getPublicKey: () => spki, getPublicKeyAlgorithm: () => -7,
    } } as unknown as Credential;
  }

  function der(raw: Uint8Array): Uint8Array {
    const integer = (value: Uint8Array) => {
      let start = 0;
      while (start < value.length - 1 && value[start] === 0) start++;
      const unsigned = value.slice(start);
      const padded = new Uint8Array(unsigned.length + (unsigned[0] & 0x80 ? 1 : 0));
      padded.set(unsigned, padded.length - unsigned.length);
      return new Uint8Array([0x02, padded.length, ...padded]);
    };
    const r = integer(raw.slice(0, 32)); const s = integer(raw.slice(32));
    return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
  }

  async function assertion(options: any, flags = 0x05, clientOverrides = {}, rpId = context.rpId): Promise<Credential> {
    const data = await authData(flags, ++assertionCounter, false, rpId);
    const client = clientData('webauthn.get', options, clientOverrides);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', client));
    const signed = new Uint8Array(data.length + hash.length); signed.set(data); signed.set(hash, data.length);
    const signature = der(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, signed)));
    return { id: b64(credentialId), type: 'public-key', rawId: bytes(credentialId), authenticatorAttachment: 'platform', response: {
      clientDataJSON: client, authenticatorData: bytes(data), signature: bytes(signature), userHandle,
    } } as unknown as Credential;
  }

  beforeEach(async () => {
    spyOn(Capacitor, 'isNativePlatform').and.returnValue(false);
    spyOn(Capacitor, 'getPlatform').and.returnValue('web');
    service = new PlatformUnlockService();
    service.forget(account); service.forget(other);
    spyOn<any>(service, 'webContext').and.returnValue(context);
    spyOn<any>(service, 'webApiAvailable').and.returnValue(true);
    availability = spyOn(PublicKeyCredential, 'isUserVerifyingPlatformAuthenticatorAvailable').and.resolveTo(true);
    keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    assertionCounter = 0;
    api = { create: jasmine.createSpy().and.callFake(registration), get: jasmine.createSpy().and.callFake(assertion) };
    spyOn<any>(service, 'credentials').and.returnValue(api);
    native = { checkBiometry: jasmine.createSpy().and.resolveTo({ isAvailable: true }), authenticate: jasmine.createSpy().and.resolveTo() };
    Object.defineProperty(service, 'biometry', { value: native });
  });

  afterEach(() => { service.cancel(); service.forget(account); service.forget(other); });

  it('does not infer Windows hardware or enroll anything while probing actual OS support', async () => {
    availability.and.resolveTo(false);
    expect(await service.availability(account)).toEqual({ available: false, enrolled: false, kind: 'none', label: 'Verificación del dispositivo', reason: 'unavailable' });
    expect(api.create).not.toHaveBeenCalled(); expect(api.get).not.toHaveBeenCalled();
    expect(native.checkBiometry).not.toHaveBeenCalled();
    (service as any).webContext.and.returnValue(null);
    availability.calls.reset();
    expect((await service.availability(account)).reason).toBe('origin-unavailable');
    expect(availability).not.toHaveBeenCalled();
  });

  it('requires explicit platform enrollment with OS verification and stores only public credential material', async () => {
    expect((await service.availability(account)).enrolled).toBeFalse();
    expect(await service.enroll(account, 'Mi cuenta')).toBeTrue();
    const options = api.create.calls.mostRecent().args[0];
    expect(options.publicKey.authenticatorSelection).toEqual({ authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' });
    expect(options.publicKey.attestation).toBe('none');
    expect(options.publicKey.challenge.byteLength).toBe(32);
    expect(options.publicKey.user.name).not.toContain(account);
    expect((await service.availability(account)).enrolled).toBeTrue();
    const record = localStorage.getItem((service as any).storageKey(account))!;
    expect(Object.keys(JSON.parse(record)).sort()).toEqual(['accountBinding', 'algorithm', 'counter', 'id', 'origin', 'publicKey', 'rpId', 'v']);
    expect(record).not.toContain('private');
  });

  it('verifies real signatures against fresh challenges and an internally bound credential', async () => {
    expect(await service.enroll(account)).toBeTrue();
    expect(await service.verify(account)).toBeTrue();
    expect(await service.verify(account)).toBeTrue();
    const first = api.get.calls.argsFor(0)[0]; const second = api.get.calls.argsFor(1)[0];
    expect(b64(new Uint8Array(first.publicKey.challenge))).not.toBe(b64(new Uint8Array(second.publicKey.challenge)));
    expect(first.publicKey.userVerification).toBe('required');
    expect(first.publicKey.allowCredentials).toEqual([{ id: bytes(credentialId), type: 'public-key', transports: ['internal'] }]);
    expect(JSON.parse(localStorage.getItem((service as any).storageKey(account))!).counter).toBe(2);
    expect(await service.verify(other)).toBeFalse();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('rejects a forged signature even when the authenticator claims user verification', async () => {
    await service.enroll(account);
    api.get.and.callFake(async options => {
      const result = await assertion(options) as unknown as PublicKeyCredential;
      const response = result.response as AuthenticatorAssertionResponse;
      new Uint8Array(response.signature)[response.signature.byteLength - 1] ^= 1;
      return result;
    });
    expect(await service.verify(account)).toBeFalse();
    expect(JSON.parse(localStorage.getItem((service as any).storageKey(account))!).counter).toBe(0);
  });

  for (const flags of [0x01, 0x04]) {
    it(`rejects a correctly signed assertion without required presence/verification flags ${flags}`, async () => {
      await service.enroll(account);
      api.get.and.callFake(options => assertion(options, flags));
      expect(await service.verify(account)).toBeFalse();
    });
  }

  for (const overrides of [{ origin: 'https://foreign.example.test' }, { challenge: 'wrong-challenge' }, { crossOrigin: true }, { type: 'webauthn.create' }]) {
    it(`rejects signed client data outside this ceremony: ${JSON.stringify(overrides)}`, async () => {
      await service.enroll(account);
      api.get.and.callFake(options => assertion(options, 0x05, overrides));
      expect(await service.verify(account)).toBeFalse();
    });
  }

  it('rejects an authenticator signature for another RP, another credential or another account handle', async () => {
    await service.enroll(account);
    api.get.and.callFake(options => assertion(options, 0x05, {}, 'foreign.example.test'));
    expect(await service.verify(account)).toBeFalse();
    api.get.and.callFake(async options => {
      const result = await assertion(options) as any;
      result.rawId = bytes(new Uint8Array([1, 2, 3])); result.id = b64(new Uint8Array(result.rawId));
      return result;
    });
    expect(await service.verify(account)).toBeFalse();
    api.get.and.callFake(async options => {
      const result = await assertion(options) as any;
      result.response.userHandle = bytes(new Uint8Array([1, 2, 3])); return result;
    });
    expect(await service.verify(account)).toBeFalse();
  });

  it('rejects a repeated signed counter and a previously valid assertion replayed for a new challenge', async () => {
    await service.enroll(account);
    let saved!: Credential;
    api.get.and.callFake(async options => { saved = await assertion(options); return saved; });
    expect(await service.verify(account)).toBeTrue();
    api.get.and.resolveTo(saved);
    expect(await service.verify(account)).toBeFalse();
    assertionCounter = 0;
    api.get.and.callFake(assertion);
    expect(await service.verify(account)).toBeFalse();
  });

  it('never registers a credential without verified creation flags or matching origin', async () => {
    api.create.and.callFake(options => registration(options, 0x41));
    expect(await service.enroll(account)).toBeFalse();
    api.create.and.callFake(options => registration(options, 0x45, { origin: 'https://foreign.example.test' }));
    expect(await service.enroll(account)).toBeFalse();
    expect(localStorage.getItem((service as any).storageKey(account))).toBeNull();
  });

  it('aborts enrollment on logout and discards a late successful OS response without storing it', async () => {
    let finish!: (credential: Credential) => void; let options: any; let ready!: () => void;
    const requested = new Promise<void>(resolve => { ready = resolve; });
    api.create.and.callFake(request => { options = request; ready(); return new Promise(resolve => { finish = resolve; }); });
    const pending = service.enroll(account);
    await requested;
    service.cancel();
    expect(options.signal.aborted).toBeTrue();
    finish(await registration(options));
    expect(await pending).toBeFalse();
    expect(localStorage.getItem((service as any).storageKey(account))).toBeNull();
    expect(service.lastError()).toBe('');
  });

  it('rejects a pending verification after switching accounts or forgetting its local binding', async () => {
    await service.enroll(account);
    let finish!: (credential: Credential) => void; let options: any; let ready!: () => void;
    let requested = new Promise<void>(resolve => { ready = resolve; });
    api.get.and.callFake(request => { options = request; ready(); return new Promise(resolve => { finish = resolve; }); });
    let pending = service.verify(account);
    await requested;
    expect(await service.verify(other)).toBeFalse();
    expect(options.signal.aborted).toBeTrue();
    finish(await assertion(options));
    expect(await pending).toBeFalse();
    requested = new Promise<void>(resolve => { ready = resolve; });
    pending = service.verify(account);
    await requested;
    service.forget(account);
    finish(await assertion(options));
    expect(await pending).toBeFalse();
    expect(localStorage.getItem((service as any).storageKey(account))).toBeNull();
  });

  it('uses real native availability and the OS biometric chooser without accepting the device PIN', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    (Capacitor.getPlatform as jasmine.Spy).and.returnValue('android');
    native.checkBiometry.and.resolveTo({ isAvailable: false, deviceIsSecure: true, code: 'biometryNotEnrolled', biometryTypes: [3, 4, 5] });
    const missing = await service.availability(account);
    expect(missing.available).toBeFalse(); expect(missing.enrolled).toBeFalse();
    expect(missing.label).toBe('Biometría del dispositivo');
    expect(await service.verify(account)).toBeFalse();
    expect(native.authenticate).not.toHaveBeenCalled();
    native.checkBiometry.and.resolveTo({ isAvailable: true, biometryTypes: [3, 4, 5] });
    expect(await service.verify(account)).toBeTrue();
    expect(native.authenticate.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({
      allowDeviceCredential: false, androidBiometryStrength: AndroidBiometryStrength.weak, cancelTitle: 'Usar PIN de la cuenta',
    }));
    expect(api.get).not.toHaveBeenCalled();
  });

  it('does not accept a native success arriving after cancellation or open a second native prompt', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    (Capacitor.getPlatform as jasmine.Spy).and.returnValue('android');
    let finish!: () => void; let ready!: () => void;
    const requested = new Promise<void>(resolve => { ready = resolve; });
    native.authenticate.and.callFake(() => { ready(); return new Promise<void>(resolve => { finish = resolve; }); });
    const old = service.verify(account);
    await requested;
    service.cancel();
    expect(await service.verify(other)).toBeFalse();
    expect(native.authenticate).toHaveBeenCalledTimes(1);
    finish();
    expect(await old).toBeFalse();
  });

  it('never exposes raw provider errors and never creates a credential from authentication failure', async () => {
    await service.enroll(account);
    api.get.and.rejectWith(new DOMException('PRIVATE_HARDWARE_PROVIDER_DETAIL', 'NotAllowedError'));
    expect(await service.verify(account)).toBeFalse();
    expect(service.lastError()).not.toContain('PRIVATE');
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('allows the legacy native OS credential prompt after biometric enrollment disappears but shared verification refuses it', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    (Capacitor.getPlatform as jasmine.Spy).and.returnValue('android');
    native.checkBiometry.and.resolveTo({ isAvailable: false, deviceIsSecure: true });
    expect(await service.verify(account)).toBeFalse();
    expect(native.authenticate).not.toHaveBeenCalled();
    expect(await service.verifyLegacyDeviceCredential(account)).toBeTrue();
    expect(native.authenticate.calls.mostRecent().args[0]).toEqual(jasmine.objectContaining({ allowDeviceCredential: true }));
  });

  it('never offers legacy device credentials on web or an unsecured native device', async () => {
    expect(await service.verifyLegacyDeviceCredential(account)).toBeFalse();
    expect(native.checkBiometry).not.toHaveBeenCalled();
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    (Capacitor.getPlatform as jasmine.Spy).and.returnValue('android');
    native.checkBiometry.and.resolveTo({ isAvailable: false, deviceIsSecure: false });
    expect(await service.verifyLegacyDeviceCredential(account)).toBeFalse();
    expect(native.authenticate).not.toHaveBeenCalled();
  });

  it('discards a legacy device credential success after logout instead of unlocking the next account', async () => {
    (Capacitor.isNativePlatform as jasmine.Spy).and.returnValue(true);
    (Capacitor.getPlatform as jasmine.Spy).and.returnValue('android');
    native.checkBiometry.and.resolveTo({ isAvailable: false, deviceIsSecure: true });
    let finish!: () => void; let ready!: () => void;
    const requested = new Promise<void>(resolve => { ready = resolve; });
    native.authenticate.and.callFake(() => { ready(); return new Promise<void>(resolve => { finish = resolve; }); });
    const pending = service.verifyLegacyDeviceCredential(account);
    await requested;
    service.cancel();
    finish();
    expect(await pending).toBeFalse();
    expect(service.lastError()).toBe('');
  });
});
