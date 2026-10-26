import { signal } from '@angular/core';
import { VaultPage } from './vault.page';

describe('vault panic action account boundaries', () => {
  const owner = (id: string) => ({ user: { id }, device: { id: `device-${id}` } });
  let session: ReturnType<typeof signal<any>>;
  let generation: ReturnType<typeof signal<number>>;
  let page: any;
  let loading: { present: jasmine.Spy; dismiss: jasmine.Spy };
  const flush = async () => { for (let step = 0; step < 8; step++) await Promise.resolve(); };

  beforeEach(() => {
    jasmine.clock().install();
    session = signal(owner('alice')); generation = signal(0);
    loading = { present: jasmine.createSpy('present').and.resolveTo(), dismiss: jasmine.createSpy('dismiss').and.resolveTo() };
    page = Object.assign(Object.create(VaultPage.prototype), {
      auth: { session, sessionGeneration: generation }, destroyed: false,
      mountedSession: owner('alice'), mountedGeneration: 0, searchTimer: null, fullscreenChangeHandler: () => undefined,
      panicPin: { matches: jasmine.createSpy('matches').and.resolveTo(true) },
      vault: { unlock: jasmine.createSpy('unlock').and.resolveTo(), enablePrivacyShield: jasmine.createSpy('enableShield').and.resolveTo(),
        disablePrivacyShield: jasmine.createSpy('disableShield').and.resolveTo(), load: jasmine.createSpy('load').and.resolveTo(),
        sendRoomText: jasmine.createSpy('sendText').and.resolveTo(), people: signal([{ id: 'bob-peer' }]),
        searchPeople: jasmine.createSpy('searchPeople').and.resolveTo(), createRoom: jasmine.createSpy('createRoom') },
      deviceWipe: { wipeAccount: jasmine.createSpy('wipe').and.resolveTo(), nukeDevice: jasmine.createSpy('nuke') },
      loadingController: { create: jasmine.createSpy('create').and.resolveTo(loading) },
      translate: { instant: (_key: string, fallback: string) => fallback },
      pin: '1234', busyId: '', error: '', notice: '',
      roomName: '', roomPin: '', roomAccessMode: 'PinOnly', retentionMode: 'Persistent', selectedInviteIds: new Set(),
    });
  });
  afterEach(() => jasmine.clock().uninstall());

  it('does not unlock or wipe a new account when an earlier PIN match returns late', async () => {
    let finish!: (value: boolean) => void;
    page.panicPin.matches.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = page.unlock();
    session.set(owner('bob')); generation.set(1); finish(true); await pending;
    expect(page.vault.unlock).not.toHaveBeenCalled();
    expect(page.deviceWipe.wipeAccount).not.toHaveBeenCalled();
    expect(page.loadingController.create).not.toHaveBeenCalled();
  });

  it('does not fall through to another account vault after a stale false PIN result', async () => {
    let finish!: (value: boolean) => void;
    page.panicPin.matches.and.returnValue(new Promise<boolean>(resolve => finish = resolve));
    const pending = page.unlock();
    session.set(owner('bob')); generation.set(1); session.set(owner('alice')); generation.set(2);
    finish(false); await pending;
    expect(page.vault.unlock).not.toHaveBeenCalled(); expect(page.deviceWipe.wipeAccount).not.toHaveBeenCalled();
  });

  it('cancels the destructive action when the account changes during the modal delay', async () => {
    const pending = page.unlock(); await flush();
    expect(loading.present).toHaveBeenCalled();
    session.set(owner('bob')); generation.set(1);
    jasmine.clock().tick(1000); await pending;
    expect(page.deviceWipe.wipeAccount).not.toHaveBeenCalled();
    expect(page.deviceWipe.nukeDevice).not.toHaveBeenCalled(); expect(loading.dismiss).toHaveBeenCalled();
  });

  it('wipes the captured exact account when the panic action remains current', async () => {
    const pending = page.unlock(); await flush();
    jasmine.clock().tick(1000); await pending;
    expect(page.deviceWipe.wipeAccount).toHaveBeenCalledOnceWith({ userId: 'alice', deviceId: 'device-alice' }, 'PANIC_PIN');
    expect(page.deviceWipe.nukeDevice).not.toHaveBeenCalled(); expect(loading.dismiss).toHaveBeenCalled();
  });

  it('does not continue initialization or disable the new account shield after destruction', async () => {
    let finish!: () => void;
    page.vault.enablePrivacyShield.and.returnValue(new Promise<void>(resolve => finish = resolve));
    page.acceptIncomingInvite = jasmine.createSpy('acceptInvite').and.resolveTo();
    const pending = page.ngOnInit();
    session.set(owner('bob')); generation.set(1); page.ngOnDestroy(); finish(); await pending;
    expect(page.vault.load).not.toHaveBeenCalled(); expect(page.acceptIncomingInvite).not.toHaveBeenCalled();
    expect(page.vault.disablePrivacyShield).not.toHaveBeenCalled();
  });

  it('does not accept an invite after a former account load finishes', async () => {
    let finish!: () => void;
    page.vault.load.and.returnValue(new Promise<void>(resolve => finish = resolve));
    page.acceptIncomingInvite = jasmine.createSpy('acceptInvite').and.resolveTo();
    const pending = page.ngOnInit(); await flush();
    expect(page.vault.load).toHaveBeenCalled();
    session.set(owner('bob')); generation.set(1); page.ngOnDestroy(); finish(); await pending;
    expect(page.acceptIncomingInvite).not.toHaveBeenCalled();
  });

  it('keeps the new account people list when an old room creation returns late', async () => {
    let finish!: (room: unknown) => void;
    page.vault.createRoom.and.returnValue(new Promise(resolve => finish = resolve));
    const pending = page.createRoom();
    session.set(owner('bob')); generation.set(1); finish({ id: 'old-room', name: 'Old room' }); await pending;
    expect(page.vault.people()).toEqual([{ id: 'bob-peer' }]);
  });

  it('blocks old page actions and search timers from operating on the new account', async () => {
    page.inviteQuery = 'old query'; page.searchInvites();
    session.set(owner('bob')); generation.set(1);
    await page.sendMessage(); jasmine.clock().tick(300);
    expect(page.vault.sendRoomText).not.toHaveBeenCalled(); expect(page.vault.searchPeople).not.toHaveBeenCalled();
  });
});
