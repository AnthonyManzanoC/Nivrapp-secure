import { Location } from '@angular/common';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Navigation, Router, convertToParamMap } from '@angular/router';
import { of } from 'rxjs';
import { PublicKeyDirectory } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { CryptoService } from '../../core/services/crypto.service';
import { IdentityTrustService } from '../../core/services/identity-trust.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { TranslateService } from '../../core/services/translate.service';
import { deriveUnverifiedSafetyNumber } from '../../core/utils/identity-fingerprint';
import { IdentityVerificationPage, identityConversationReturnUrl } from './identity-verification.page';

const directory = (userId: string, x: string): PublicKeyDirectory => ({
  userId,
  alias: userId,
  devices: [{
    deviceId: 'phone',
    deviceName: 'phone',
    keyBundle: { identityKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: x.repeat(43), y: 'B'.repeat(43) }), signedPreKey: null, preKeySignature: null, oneTimePreKeys: [] },
    lastRotatedAt: '2026-10-06T00:00:00.000Z',
  }],
});

describe('Identity verification return and comparison', () => {
  const conversationUrl = '/app/chats/conversation-42';
  let navigation: Navigation | null;
  let historyState: Record<string, unknown>;
  let location: { back: jasmine.Spy; getState: () => Record<string, unknown> };
  let router: { getCurrentNavigation: () => Navigation | null; navigateByUrl: jasmine.Spy };
  let session: ReturnType<typeof signal<{ user: { id: string; alias: string }; device: { id: string } }>>;
  let own: PublicKeyDirectory;
  let other: PublicKeyDirectory;
  let api: { post: jasmine.Spy };
  let trust: { confirm: jasmine.Spy };
  let cryptoService: { currentKeyMaterial: jasmine.Spy; parsePublicJwk: (value: string) => JsonWebKey };

  beforeEach(() => {
    navigation = {
      trigger: 'imperative',
      extras: { state: { identityReturnUrl: conversationUrl } },
      previousNavigation: { finalUrl: { toString: () => conversationUrl } },
    } as unknown as Navigation;
    historyState = {};
    location = { back: jasmine.createSpy('back'), getState: () => historyState };
    router = { getCurrentNavigation: () => navigation, navigateByUrl: jasmine.createSpy('navigateByUrl').and.resolveTo(true) };
    session = signal({ user: { id: 'alice', alias: 'alice' }, device: { id: 'phone' } });
    own = directory('alice', 'A');
    other = directory('bob', 'C');
    api = { post: jasmine.createSpy('post').and.callFake(() => of([own, other])) };
    trust = { confirm: jasmine.createSpy('confirm').and.resolveTo() };
    cryptoService = {
      currentKeyMaterial: jasmine.createSpy('currentKeyMaterial').and.resolveTo({ publicJwk: JSON.parse(own.devices[0].keyBundle.identityKey!) }),
      parsePublicJwk: (value: string) => JSON.parse(value),
    };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session } },
      { provide: CryptoService, useValue: cryptoService },
      { provide: NivraApiService, useValue: api },
      { provide: IdentityTrustService, useValue: trust },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: convertToParamMap({ userId: 'bob' }) } } },
      { provide: Router, useValue: router },
      { provide: Location, useValue: location },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
  });

  function createPage(): IdentityVerificationPage {
    const page = TestBed.runInInjectionContext(() => new IdentityVerificationPage());
    (page as unknown as { target: string }).target = 'bob';
    return page;
  }

  it('returns through history to the exact conversation that opened verification', () => {
    createPage().back();
    expect(location.back).toHaveBeenCalledTimes(1);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });

  it('restores the conversation after refreshing the verification route without leaving the app', () => {
    navigation = null;
    historyState = { identityReturnUrl: conversationUrl };
    createPage().back();
    expect(location.back).not.toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith(conversationUrl, { replaceUrl: true });
  });

  it('does not follow browser history when it points at another screen', () => {
    navigation = { ...navigation!, previousNavigation: { finalUrl: { toString: () => '/app/account' } } } as unknown as Navigation;
    createPage().back();
    expect(location.back).not.toHaveBeenCalled();
    expect(router.navigateByUrl).toHaveBeenCalledWith(conversationUrl, { replaceUrl: true });
  });

  it('rejects external, auth, traversal and empty return destinations', () => {
    for (const destination of ['https://example.test', '//example.test', '/auth', '/app/chats', '/app/chats/..', '/app/chats/42\\else', null]) {
      expect(identityConversationReturnUrl(destination)).toBeNull();
    }
    expect(identityConversationReturnUrl('/app/chats/conversation-42?search=test')).toBe('/app/chats/conversation-42?search=test');
    navigation = null;
    historyState = { identityReturnUrl: 'https://example.test' };
    createPage().back();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/app/chats', { replaceUrl: true });
  });

  it('does not save trust for an unmatched comparison', async () => {
    const page = createPage();
    page.code = (await deriveUnverifiedSafetyNumber(own, other)).display;
    page.comparison = 'invalid';
    await page.confirm();
    expect(trust.confirm).not.toHaveBeenCalled();
    expect(page.verified).toBeFalse();
    expect(page.message).toContain('no coinciden');
  });

  it('saves the same cryptographic directory only after a matching comparison', async () => {
    const page = createPage();
    page.code = (await deriveUnverifiedSafetyNumber(own, other)).display;
    page.comparison = `nivra-identity-v1:${page.code.toUpperCase()}`;
    await page.confirm();
    expect(trust.confirm).toHaveBeenCalledOnceWith(JSON.stringify(['alice', 'phone']), other);
    expect(page.verified).toBeTrue();
    expect(page.busy).toBeFalse();
  });

  it('loads the same comparison code alongside legacy devices without published identities', async () => {
    const expected = (await deriveUnverifiedSafetyNumber(own, other)).display;
    const legacy = { ...other.devices[0], deviceId: 'old-browser', keyBundle: { ...other.devices[0].keyBundle, identityKey: null } };
    own.devices.push({ ...legacy, deviceId: 'old-own-browser' });
    other.devices.push(legacy, { ...legacy, deviceId: 'empty-browser', keyBundle: { ...legacy.keyBundle, identityKey: '  ' } });
    const page = createPage(); await page.loadIdentity();
    expect(page.loading).toBeFalse(); expect(page.message).toBe('');
    expect(page.code).toBe(expected); expect(page.qr).toMatch(/^data:image\/png/);
    expect(trust.confirm).not.toHaveBeenCalled(); expect(page.verified).toBeFalse();
    page.comparison = page.code; await page.confirm();
    expect(trust.confirm).toHaveBeenCalledOnceWith(JSON.stringify(['alice', 'phone']), other);
    expect(page.verified).toBeTrue();
  });

  it('does not prepare or accept a comparison for a nonempty malformed identity', async () => {
    const page = createPage();
    other.devices.push({ ...other.devices[0], deviceId: 'invalid', keyBundle: { ...other.devices[0].keyBundle, identityKey: '{broken' } });
    await page.loadIdentity();
    expect(page.code).toBe(''); expect(page.qr).toBe(''); expect(page.message).toContain('No se pudieron cargar');
    page.comparison = 'invented'; await page.confirm();
    expect(trust.confirm).not.toHaveBeenCalled(); expect(page.verified).toBeFalse();
  });

  it('refuses to verify when peer keys change after the QR was prepared', async () => {
    const page = createPage();
    page.code = (await deriveUnverifiedSafetyNumber(own, other)).display;
    page.comparison = page.code;
    other = directory('bob', 'D');
    await page.confirm();
    expect(trust.confirm).not.toHaveBeenCalled();
    expect(page.message).toContain('llaves cambiaron');
  });

  it('does not save trust into a different account while keys are loading', async () => {
    const page = createPage();
    page.code = (await deriveUnverifiedSafetyNumber(own, other)).display;
    page.comparison = page.code;
    cryptoService.currentKeyMaterial.and.callFake(async () => {
      session.set({ user: { id: 'new-account', alias: 'new-account' }, device: { id: 'new-device' } });
      return { publicJwk: JSON.parse(own.devices[0].keyBundle.identityKey!) };
    });
    await page.confirm();
    expect(trust.confirm).not.toHaveBeenCalled();
    expect(page.verified).toBeFalse();
  });

  it('does not publish an old account comparison after delayed QR generation finishes', async () => {
    const page = createPage();
    let release!: (qr: string) => void;
    let reached!: () => void;
    const pending = new Promise<string>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    spyOn<any>(page, 'qrForComparison').and.callFake(() => { reached(); return pending; });
    const loading = page.loadIdentity(); await started;
    session.set({ user: { id: 'other-account', alias: 'other-account' }, device: { id: 'other-device' } });
    release('data:image/png;base64,old-account'); await loading;
    expect(page.code).toBe(''); expect(page.qr).toBe(''); expect(page.message).toBe('');
    expect(trust.confirm).not.toHaveBeenCalled();
  });

  it('keeps the latest retry when an older QR request finishes afterward', async () => {
    const page = createPage();
    let release!: (qr: string) => void;
    let reached!: () => void;
    let calls = 0;
    const pending = new Promise<string>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    spyOn<any>(page, 'qrForComparison').and.callFake(() => {
      if (++calls === 1) { reached(); return pending; }
      return Promise.resolve('data:image/png;base64,latest');
    });
    const oldRequest = page.loadIdentity(); await started;
    other = directory('bob', 'D');
    const expected = (await deriveUnverifiedSafetyNumber(own, other)).display;
    await page.loadIdentity();
    release('data:image/png;base64,old'); await oldRequest;
    expect(page.loading).toBeFalse(); expect(page.code).toBe(expected);
    expect(page.qr).toBe('data:image/png;base64,latest');
  });

  it('does not show verification success to another account after trust storage finishes', async () => {
    const page = createPage();
    page.code = (await deriveUnverifiedSafetyNumber(own, other)).display;
    page.comparison = page.code;
    let release!: () => void;
    let reached!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { reached = resolve; });
    trust.confirm.and.callFake(() => { reached(); return pending; });
    const confirmation = page.confirm(); await started;
    session.set({ user: { id: 'other-account', alias: 'other-account' }, device: { id: 'other-device' } });
    release(); await confirmation;
    expect(trust.confirm).toHaveBeenCalledOnceWith(JSON.stringify(['alice', 'phone']), other);
    expect(page.verified).toBeFalse(); expect(page.message).toBe('');
  });
});
