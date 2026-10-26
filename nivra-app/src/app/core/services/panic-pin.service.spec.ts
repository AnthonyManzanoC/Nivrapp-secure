import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { PanicPinService } from './panic-pin.service';

describe('panic PIN account boundaries', () => {
  const first = 'panic-pin-test-alice';
  const second = 'panic-pin-test-bob';
  const key = (id: string) => `nivra.panicPin.v1.${id}`;
  const hash = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  const record = { v: 1, alg: 'PBKDF2-SHA256', iterations: 240000,
    salt: btoa(String.fromCharCode(...new Uint8Array(16))), hash, createdAt: '2026-10-25', updatedAt: '2026-10-25' };
  let session: ReturnType<typeof signal<any>>;
  let generation: ReturnType<typeof signal<number>>;
  let service: PanicPinService;
  let previous: Array<[string, string | null]>;

  beforeEach(() => {
    previous = [first, second].map(id => [key(id), localStorage.getItem(key(id))]);
    for (const id of [first, second]) localStorage.setItem(key(id), JSON.stringify(record));
    session = signal({ user: { id: first }, device: { id: 'device-a' } }); generation = signal(0);
    TestBed.configureTestingModule({ providers: [PanicPinService, { provide: AuthService, useValue: { session, sessionGeneration: generation } }] });
    service = TestBed.inject(PanicPinService); TestBed.flushEffects();
  });

  afterEach(() => {
    TestBed.resetTestingModule();
    for (const [name, value] of previous) value === null ? localStorage.removeItem(name) : localStorage.setItem(name, value);
  });

  it('never rewrites a wiped owner key or publishes its state after hashing finishes on another account', async () => {
    let finish!: (value: string) => void;
    spyOn<any>(service, 'hashPin').and.returnValue(new Promise<string>(resolve => finish = resolve));
    const pending = service.configure('1234');
    localStorage.removeItem(key(first));
    session.set({ user: { id: second }, device: { id: 'device-b' } }); generation.set(1); TestBed.flushEffects();
    finish(hash);
    await expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
    expect(localStorage.getItem(key(first))).toBeNull();
    expect(localStorage.getItem(key(second))).toBe(JSON.stringify(record));
    expect(service.isConfigured()).toBeTrue();
  });

  it('does not return a panic match after an Alice to Bob to Alice transition', async () => {
    let finish!: (value: string) => void;
    spyOn<any>(service, 'hashPin').and.returnValue(new Promise<string>(resolve => finish = resolve));
    const pending = service.matches('1234');
    session.set({ user: { id: second }, device: { id: 'device-b' } }); generation.set(1);
    session.set({ user: { id: first }, device: { id: 'device-a' } }); generation.set(2);
    finish(hash);
    expect(await pending).toBeFalse();
  });

  it('does not show a previous account configuration before the account effect runs', () => {
    localStorage.removeItem(key(second));
    session.set({ user: { id: second }, device: { id: 'device-b' } }); generation.set(1);
    expect(service.isConfigured()).toBeFalse();
  });

  it('invalidates a pending configuration when the PIN is cleared on the same account', async () => {
    let finish!: (value: string) => void;
    spyOn<any>(service, 'hashPin').and.returnValue(new Promise<string>(resolve => finish = resolve));
    const pending = service.configure('1234');
    service.clear(); finish(hash);
    await expectAsync(pending).toBeRejectedWithError('ACCOUNT_SESSION_CHANGED');
    expect(localStorage.getItem(key(first))).toBeNull(); expect(service.isConfigured()).toBeFalse();
  });

  it('keeps normal configured PIN matching within the same account and device', async () => {
    spyOn<any>(service, 'hashPin').and.resolveTo(hash);
    await service.configure('1234');
    expect(service.isConfigured()).toBeTrue(); expect(await service.matches('1234')).toBeTrue();
    expect(localStorage.getItem(key(first))).not.toContain('1234');
  });

  it('keeps a same-account match valid across ordinary access token renewal', async () => {
    let finish!: (value: string) => void;
    spyOn<any>(service, 'hashPin').and.returnValue(new Promise<string>(resolve => finish = resolve));
    const pending = service.matches('1234');
    session.set({ user: { id: first }, device: { id: 'device-a' }, tokens: { accessToken: 'rotated' } }); TestBed.flushEffects();
    finish(hash); expect(await pending).toBeTrue();
  });
});
