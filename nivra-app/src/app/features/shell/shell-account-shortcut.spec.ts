import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { ShellPage } from './shell.page';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { SignalrService } from '../../core/services/signalr.service';
import { UnreadTabService } from '../../core/services/unread-tab.service';
import { ClientCompatibilityService } from '../../core/services/client-compatibility.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { TranslateService } from '../../core/services/translate.service';
import { AccountSessionSummary } from '../../core/services/account-sessions.service';

@Component({ standalone: true, template: '<p>Account shortcut fixture</p>' })
class ShortcutTab { }

describe('saved-account navigation shortcut', () => {
  let fixture: ComponentFixture<ShellPage>;
  let router: Router;
  let auth: any;
  let calls: { activeCall: ReturnType<typeof signal<any>>; resumableCall: ReturnType<typeof signal<any>>;
    phase: ReturnType<typeof signal<string>>; audioOutput: { playbackBlocked: ReturnType<typeof signal<boolean>> }; callTitle: () => string };
  let locked: ReturnType<typeof signal<boolean>>;
  let now: number;
  let visibility: jasmine.Spy;
  const alice: AccountSessionSummary = { id: 'alice', alias: 'alice', displayName: 'Alice', profilePhotoDataUrl: null, active: true };
  const bob: AccountSessionSummary = { id: 'bob', alias: 'bob', displayName: 'Bob', profilePhotoDataUrl: null, active: false };
  const session = (userId: string, deviceId = 'fixture-device') => ({ user: { id: userId }, device: { id: deviceId } });

  beforeEach(async () => {
    now = 1000;
    spyOn(performance, 'now').and.callFake(() => now);
    visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('visible');
    auth = { session: signal(session('alice')), sessionGeneration: signal(1), savedAccounts: signal([alice, bob]),
      accountsBusy: signal(false), addingAccount: signal(false), accountError: signal(''), switchAccount: jasmine.createSpy('switchAccount') };
    calls = { activeCall: signal(null), resumableCall: signal(null), phase: signal('idle'),
      audioOutput: { playbackBlocked: signal(false) }, callTitle: () => 'Fixture call' };
    locked = signal(false);
    await TestBed.configureTestingModule({ imports: [ShellPage], providers: [
      provideRouter(['chats', 'world', 'vault', 'calls', 'account'].map(tab => ({ path: `app/${tab}`, component: ShortcutTab }))),
      { provide: AuthService, useValue: auth }, { provide: CallsService, useValue: calls },
      { provide: SignalrService, useValue: {} }, { provide: UnreadTabService, useValue: { unreadChats: signal(0) } },
      { provide: ClientCompatibilityService, useValue: { check: jasmine.createSpy('check').and.resolveTo(), updateRequired: signal(false) } },
      { provide: AppLockService, useValue: { isContentLocked: locked } },
      { provide: NivraApiService, useValue: { baseUrl: 'https://fixture.invalid' } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: signal('es') } },
    ] }).compileComponents();
    router = TestBed.inject(Router);
    auth.switchAccount.and.callFake(async (userId: string) => {
      activate(userId);
      await router.navigateByUrl('/app/chats', { replaceUrl: true });
      return true;
    });
    fixture = TestBed.createComponent(ShellPage);
    fixture.detectChanges();
    await router.navigateByUrl('/app/chats');
    fixture.detectChanges();
  });

  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });

  function activate(userId: string): void {
    auth.session.set(session(userId)); auth.sessionGeneration.update((generation: number) => generation + 1);
    auth.savedAccounts.set([alice, bob].map(account => ({ ...account, active: account.id === userId })));
  }
  function link(path = 'account'): HTMLAnchorElement {
    return fixture.nativeElement.querySelector(`a.nav-btn[href="/app/${path}"]`);
  }
  function click(path = 'account', options: MouseEventInit = {}): MouseEvent {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, ...options });
    const anchor = link(path);
    // Cancel only the browser's native modified-link default, after RouterLink
    // and the shell capture listener have had their real event ordering.
    const cancelDefault = (click: Event): void => click.preventDefault();
    anchor.addEventListener('click', cancelDefault);
    anchor.querySelector('span')!.dispatchEvent(event);
    anchor.removeEventListener('click', cancelDefault);
    return event;
  }
  async function settle(): Promise<void> { await fixture.whenStable(); fixture.detectChanges(); await fixture.whenStable(); }
  async function firstTap(): Promise<void> { click(); await settle(); now += 120; }

  it('opens Cuenta on the first tap without a timer, and exposes the optional shortcut accessibly', async () => {
    click(); await settle();
    expect(router.url).toBe('/app/account');
    expect(auth.switchAccount).not.toHaveBeenCalled();
    expect(link().title).toContain('Pulsa dos veces para cambiar de cuenta');
    expect(link().getAttribute('aria-label')).toContain('Pulsa dos veces para cambiar de cuenta');
  });

  it('captures the second tap before RouterLink and leaves the other account on Chats', async () => {
    await firstTap(); click(); await settle();
    expect(auth.switchAccount).toHaveBeenCalledOnceWith('bob');
    expect(auth.session().user.id).toBe('bob');
    expect(router.url).toBe('/app/chats');
    now += 500;
    await firstTap(); click(); await settle();
    expect(auth.switchAccount.calls.allArgs()).toEqual([['bob'], ['alice']]);
    expect(router.url).toBe('/app/chats');
  });

  it('keeps repeated keyboard activation as ordinary navigation', async () => {
    click('account', { detail: 0 }); await settle(); now += 80;
    click('account', { detail: 0 }); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
    expect(router.url).toBe('/app/account');
  });

  it('does not combine two deliberate taps more than 350 ms apart', async () => {
    await firstTap(); now += 231; click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
    expect(router.url).toBe('/app/account');
  });

  it('clears a sequence when another tab is selected or another route finishes', async () => {
    await firstTap(); click('world'); await settle(); click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
    await router.navigateByUrl('/app/chats'); click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
  });

  it('does not treat modified, secondary or keyboard clicks as the first tap', async () => {
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }, { detail: 0 }]) {
      click('account', options); await settle(); now += 30;
      click(); await settle(); now += 500;
      expect(auth.switchAccount).not.toHaveBeenCalled();
    }
  });

  it('requires exactly two distinct accounts with the current profile marked active', async () => {
    for (const accounts of [[alice], [alice, alice], [alice, { ...bob, id: '' }], [{ ...alice, active: false }, bob],
      [alice, { ...bob, active: true }], [{ ...alice, id: 'other' }, bob], [alice, bob, { ...bob, id: 'third' }]]) {
      auth.savedAccounts.set(accounts); fixture.detectChanges();
      expect(link().title).not.toContain('Pulsa dos veces');
      await firstTap(); click(); await settle(); now += 500;
    }
    expect(auth.switchAccount).not.toHaveBeenCalled();
  });

  it('blocks switching while busy, adding a profile, locked, or in an active/resumable call', async () => {
    for (const guard of [auth.accountsBusy, auth.addingAccount, locked, calls.activeCall, calls.resumableCall]) {
      await firstTap(); guard.set(guard === calls.activeCall || guard === calls.resumableCall ? { id: 'fixture-call' } : true);
      click(); await settle();
      guard.set(guard === calls.activeCall || guard === calls.resumableCall ? null : false);
      now += 500;
    }
    expect(auth.switchAccount).not.toHaveBeenCalled();
  });

  it('rejects a pending pair after an account/device generation change, including A to B to A', async () => {
    await firstTap(); activate('bob'); activate('alice'); click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
    now += 500; await firstTap(); auth.session.set(session('alice', 'replacement-device')); click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
  });

  it('absorbs triple taps throughout an in-flight switch and its trailing burst', async () => {
    let finish!: () => void;
    auth.switchAccount.and.callFake(async (userId: string) => {
      await new Promise<void>(resolve => { finish = resolve; });
      activate(userId); await router.navigateByUrl('/app/chats', { replaceUrl: true }); return true;
    });
    await firstTap(); click(); now += 50; click();
    expect(auth.switchAccount).toHaveBeenCalledOnceWith('bob');
    finish(); await settle();
    click(); await settle();
    expect(auth.switchAccount).toHaveBeenCalledTimes(1);
    expect(router.url).toBe('/app/chats');
  });

  it('leaves normal service failures on Cuenta and handles unexpected rejection without losing the session', async () => {
    auth.switchAccount.and.resolveTo(false);
    await firstTap(); click(); await settle();
    expect(auth.session().user.id).toBe('alice'); expect(router.url).toBe('/app/account');
    now += 500; auth.switchAccount.and.rejectWith(new Error('fixture failure'));
    await firstTap(); click(); await settle();
    expect(auth.session().user.id).toBe('alice'); expect(router.url).toBe('/app/account');
    expect(auth.accountError()).toContain('Sus sesiones e historial se han conservado');
  });

  it('cancels pending pairs when the window loses focus or visibility changes', async () => {
    await firstTap(); window.dispatchEvent(new Event('blur')); click(); await settle();
    expect(auth.switchAccount).not.toHaveBeenCalled();
    now += 500; await firstTap(); visibility.and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); visibility.and.returnValue('visible');
    click(); await settle(); expect(auth.switchAccount).not.toHaveBeenCalled();
  });

  it('does not publish a late unexpected failure into a different account generation', async () => {
    let reject!: (error: Error) => void;
    auth.switchAccount.and.returnValue(new Promise<boolean>((_resolve, rejectSwitch) => { reject = rejectSwitch; }));
    await firstTap(); click(); activate('bob'); reject(new Error('late fixture failure')); await settle();
    expect(auth.session().user.id).toBe('bob');
    expect(auth.accountError()).toBe('');
  });

  it('removes capture and lifecycle listeners when the shell is destroyed', async () => {
    const hostRemove = spyOn(fixture.nativeElement as HTMLElement, 'removeEventListener').and.callThrough();
    const windowRemove = spyOn(window, 'removeEventListener').and.callThrough();
    const documentRemove = spyOn(document, 'removeEventListener').and.callThrough();
    fixture.destroy();
    expect(hostRemove).toHaveBeenCalledWith('click', jasmine.any(Function), true);
    expect(windowRemove).toHaveBeenCalledWith('blur', jasmine.any(Function));
    expect(documentRemove).toHaveBeenCalledWith('visibilitychange', jasmine.any(Function));
  });
});
