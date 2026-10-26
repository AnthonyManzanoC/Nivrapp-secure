import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { ContactSyncService } from '../../core/services/contact-sync.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { FriendRequest, UserSummary } from '../../core/models/nivra.models';
import { WorldPage } from './world.page';

describe('World request actions and account boundaries', () => {
  let page: WorldPage;
  let session: ReturnType<typeof signal<any>>;
  let social: any;
  let router: { navigateByUrl: jasmine.Spy };
  let chat: any;
  const user = (id: string) => ({ id, alias: id, displayName: id, friendshipState: 'none' }) as UserSummary;
  beforeEach(() => {
    session = signal({ user: { id: 'alice', isDiscoverable: false }, device: { id: 'phone' } });
    social = { accept: jasmine.createSpy().and.resolveTo(), reject: jasmine.createSpy().and.resolveTo(), cancel: jasmine.createSpy().and.resolveTo(),
      requestFriend: jasmine.createSpy().and.resolveTo(), incomingRequests: signal([]), connectionActions: signal([]) };
    router = { navigateByUrl: jasmine.createSpy().and.resolveTo(true) };
    chat = { createDirectConversation: jasmine.createSpy().and.resolveTo({ id: 'direct' }) };
    TestBed.configureTestingModule({ providers: [
      { provide: SocialService, useValue: social }, { provide: AuthService, useValue: { session } },
      { provide: ChatService, useValue: chat }, { provide: ContactSyncService, useValue: {} },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
      { provide: Router, useValue: router }, { provide: ToastController, useValue: {} },
    ] });
    page = TestBed.runInInjectionContext(() => new WorldPage());
    TestBed.flushEffects();
  });
  afterEach(() => { page.ngOnDestroy(); TestBed.resetTestingModule(); });
  it('shows the destination on outgoing requests and the sender on incoming ones', () => {
    expect(page.requestPerson({ from: user('alice'), to: user('bob') } as FriendRequest).id).toBe('bob');
    expect(page.requestPerson({ from: user('carol'), to: user('alice') } as FriendRequest).id).toBe('carol');
  });
  it('uses Spanish status labels instead of raw server enums', () => {
    expect(page.requestStatus({ status: 'Accepted' } as FriendRequest)).toBe('Aceptada');
    expect(page.requestStatus({ status: 'Pending' } as FriendRequest)).toBe('Pendiente');
    expect(page.requestStatus({ status: 'Rejected' } as FriendRequest)).toBe('Rechazada');
    expect(page.friendshipLabel({ ...user('bob'), friendshipState: 'requested' })).toBe('Solicitud enviada');
  });
  it('does not claim ghost discovery restrictions just because no phone is linked', () => {
    expect(page.isGhostMode()).toBeTrue();
    session.set({ user: { id: 'alice', isDiscoverable: true }, device: { id: 'phone' } });
    expect(page.isGhostMode()).toBeFalse();
  });
  it('prevents double-click and conflicting actions on the same request', async () => {
    let finish!: () => void;
    social.accept.and.returnValue(new Promise<void>(resolve => finish = resolve));
    const pending = page.accept('incoming');
    await page.accept('incoming'); await page.reject('incoming');
    expect(social.accept).toHaveBeenCalledTimes(1); expect(social.reject).not.toHaveBeenCalled();
    expect(page.isBusy('incoming')).toBeTrue(); finish(); await pending;
    expect(page.isBusy('incoming')).toBeFalse();
  });
  it('does not navigate to an old direct chat after the account changes', async () => {
    let finish!: (value: { id: string }) => void;
    chat.createDirectConversation.and.returnValue(new Promise(resolve => finish = resolve));
    const pending = page.openPerson(user('bob'));
    session.set({ user: { id: 'other', isDiscoverable: true }, device: { id: 'other' } }); TestBed.flushEffects();
    finish({ id: 'old-direct' }); await pending;
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });
  it('does not overwrite a new account notice with an old action error', async () => {
    let reject!: (error: Error) => void;
    social.accept.and.returnValue(new Promise((_resolve, failed) => reject = failed));
    const pending = page.accept('incoming');
    session.set({ user: { id: 'other', isDiscoverable: true }, device: { id: 'other' } }); TestBed.flushEffects();
    page.notice = 'Estado de la cuenta nueva';
    reject(new Error('respuesta antigua')); await pending;
    expect(page.error).toBe(''); expect(page.notice).toBe('Estado de la cuenta nueva'); expect(page.busyId).toBe('');
  });
});
