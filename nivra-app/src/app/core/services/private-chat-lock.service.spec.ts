import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { NavigationStart, Router } from '@angular/router';
import { Subject } from 'rxjs';
import { AppLockService } from './app-lock.service';
import { AuthService } from './auth.service';
import { PrivateChatLockService } from './private-chat-lock.service';
import { privateChatLockStorageKey, readPrivateChatLocks, writePrivateChatLocks } from './private-chat-lock-metadata';

describe('private conversation access', () => {
  let locks: PrivateChatLockService;
  let auth: any;
  let app: any;
  let navigation: Subject<any>;
  const owner = (id = 'private-chat-fixture-a') => ({ user: { id }, device: { id: `device-${id}` } });
  beforeEach(() => {
    for (const id of ['private-chat-fixture-a', 'private-chat-fixture-b']) localStorage.removeItem(privateChatLockStorageKey(id));
    navigation = new Subject();
    auth = { session: signal(owner()), sessionGeneration: signal(1) };
    app = { isEnabled: signal(true), isShared: signal(true), policyPending: signal(false), isContentLocked: signal(false),
      unlockError: signal('PIN incorrecto.'), cancelProtectedActionVerification: jasmine.createSpy('cancelProtected'),
      verifyProtectedAction: jasmine.createSpy('verifyProtected').and.resolveTo(true),
      verifyProtectedActionWithBiometrics: jasmine.createSpy('verifyBiometric').and.resolveTo(true) };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: AppLockService, useValue: app },
      { provide: Router, useValue: { events: navigation, navigate: jasmine.createSpy().and.resolveTo(true) } },
    ] });
    locks = TestBed.inject(PrivateChatLockService); TestBed.flushEffects();
  });
  afterEach(() => { TestBed.resetTestingModule(); for (const id of ['private-chat-fixture-a', 'private-chat-fixture-b']) localStorage.removeItem(privateChatLockStorageKey(id)); });

  it('requires fresh verification despite an already open application, and never persists the PIN', async () => {
    expect(await locks.authenticate('chat-one', 'protect', '4499')).toBeTrue();
    expect(app.verifyProtectedAction).toHaveBeenCalledOnceWith('4499');
    expect(locks.isProtected('chat-one')).toBeTrue();
    expect(locks.isLocked('chat-one')).toBeFalse();
    expect(localStorage.getItem(privateChatLockStorageKey(owner().user.id))).not.toContain('4499');
    locks.relock();
    expect(locks.isLocked('chat-one')).toBeTrue();
    expect(await locks.authenticate('chat-one', 'unlock', '4499')).toBeTrue();
    expect(app.verifyProtectedAction).toHaveBeenCalledTimes(2);
  });

  it('does not protect or unprotect a conversation on failed authentication', async () => {
    app.verifyProtectedAction.and.resolveTo(false);
    expect(await locks.authenticate('chat-one', 'protect', '0000')).toBeFalse();
    expect(locks.isProtected('chat-one')).toBeFalse();
    writePrivateChatLocks(owner().user.id, ['chat-two']);
    window.dispatchEvent(new StorageEvent('storage', { key: privateChatLockStorageKey(owner().user.id) }));
    expect(await locks.authenticate('chat-two', 'remove', '0000')).toBeFalse();
    expect(locks.isLocked('chat-two')).toBeTrue();
    expect(locks.error()).toContain('PIN incorrecto');
  });

  it('redacts saved inactive accounts without reusing the current account grant', async () => {
    writePrivateChatLocks('private-chat-fixture-b', ['private-b']);
    await locks.authenticate('chat-one', 'protect', '4499');
    expect(locks.protectedIdsForUser('private-chat-fixture-b')).toEqual(['private-b']);
    auth.session.set(owner('private-chat-fixture-b'));
    expect(locks.isLocked('private-b')).toBeTrue();
    expect(locks.isProtected('chat-one')).toBeFalse();
  });

  it('invalidates a grant synchronously on session generation change', async () => {
    await locks.authenticate('chat-one', 'protect', '4499');
    auth.sessionGeneration.update((value: number) => value + 1);
    expect(locks.isLocked('chat-one')).toBeTrue();
  });

  it('discards late authentication after switching account without saving metadata', async () => {
    let finish!: (value: boolean) => void;
    app.verifyProtectedAction.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = locks.authenticate('chat-one', 'protect', '4499');
    auth.session.set(owner('private-chat-fixture-b')); TestBed.flushEffects(); finish(true);
    expect(await pending).toBeFalse();
    expect(readPrivateChatLocks('private-chat-fixture-a')).toEqual([]);
    expect(readPrivateChatLocks('private-chat-fixture-b')).toEqual([]);
  });

  it('cancels a pending OS prompt on navigation and ignores its successful late completion', async () => {
    let finish!: (value: boolean) => void;
    app.verifyProtectedActionWithBiometrics.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = locks.authenticate('chat-one', 'protect', undefined, true);
    navigation.next(new NavigationStart(1, '/app/account')); finish(true);
    expect(await pending).toBeFalse(); expect(locks.isProtected('chat-one')).toBeFalse();
    expect(app.cancelProtectedActionVerification).toHaveBeenCalled();
  });

  it('relocks the chat when leaving its route or hiding the application', async () => {
    await locks.authenticate('chat-one', 'protect', '4499');
    navigation.next(new NavigationStart(1, '/app/chats/chat-one?focus=last'));
    expect(locks.isLocked('chat-one')).toBeFalse();
    navigation.next(new NavigationStart(2, '/app/world')); expect(locks.isLocked('chat-one')).toBeTrue();
    await locks.authenticate('chat-one', 'unlock', '4499');
    spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(locks.isLocked('chat-one')).toBeTrue();
  });

  it('permits one protected conversation at a time and never unlocks all chats', async () => {
    await locks.authenticate('chat-one', 'protect', '4499');
    await locks.authenticate('chat-two', 'protect', '4499');
    expect(locks.isLocked('chat-one')).toBeTrue(); expect(locks.isLocked('chat-two')).toBeFalse();
    app.isContentLocked.set(true); expect(locks.isLocked('chat-two')).toBeTrue();
  });

  it('preserves another tab’s concurrent protection change when writing its own', async () => {
    let finish!: (value: boolean) => void;
    app.verifyProtectedAction.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = locks.authenticate('chat-one', 'protect', '4499');
    writePrivateChatLocks(owner().user.id, ['chat-from-other-tab']); finish(true);
    expect(await pending).toBeTrue();
    expect(readPrivateChatLocks(owner().user.id)).toEqual(['chat-from-other-tab', 'chat-one']);
  });

  it('does not claim success if the local policy cannot be persisted', async () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('Storage unavailable');
    expect(await locks.authenticate('chat-one', 'protect', '4499')).toBeFalse();
    expect(locks.isProtected('chat-one')).toBeFalse(); expect(locks.error()).toContain('Storage unavailable');
  });

  it('fails closed for malformed or foreign account metadata', () => {
    localStorage.setItem(privateChatLockStorageKey(owner().user.id), JSON.stringify({ v: 1, userId: 'foreign', ids: ['secret'] }));
    window.dispatchEvent(new StorageEvent('storage', { key: privateChatLockStorageKey(owner().user.id) }));
    expect(locks.protectedIdsForUser(owner().user.id)).toEqual(['*']);
    expect(locks.isLocked('any-conversation')).toBeTrue();
  });

  it('retains protection when shared policy becomes unresolved or disabled', async () => {
    await locks.authenticate('chat-one', 'protect', '4499');
    app.policyPending.set(true); expect(locks.isLocked('chat-one')).toBeTrue();
    expect(await locks.authenticate('chat-one', 'remove', '4499')).toBeFalse();
    app.policyPending.set(false); app.isEnabled.set(false);
    expect(locks.isLocked('chat-one')).toBeTrue();
  });
});
