import { TestBed } from '@angular/core/testing';
import { DESKTOP_UPDATE_RUNTIME, DesktopUpdateBridge, DesktopUpdateService, DesktopUpdateState } from './desktop-update.service';

describe('Desktop update presentation and lifecycle', () => {
  let service: DesktopUpdateService;
  let bridge: jasmine.SpyObj<DesktopUpdateBridge>;
  let now: number;
  const available = { status: 'available' as const, currentVersion: '4.1.0', version: '4.2.0', size: 123456 };
  beforeEach(() => {
    now = 10000000;
    bridge = jasmine.createSpyObj('bridge', ['checkForUpdate', 'downloadUpdate', 'installUpdate', 'getUpdateState', 'onUpdateState']);
    bridge.checkForUpdate.and.resolveTo(available);
    bridge.downloadUpdate.and.resolveTo({ ...available, status: 'downloaded' });
    bridge.installUpdate.and.resolveTo({ ...available, status: 'installing' });
    bridge.onUpdateState.and.returnValue(() => undefined);
    TestBed.configureTestingModule({ providers: [{ provide: DESKTOP_UPDATE_RUNTIME, useValue: { bridge, now: () => now } }] });
    service = TestBed.inject(DesktopUpdateService);
    service.safe.set(true); service.foreground.set(true);
  });

  it('does nothing in a browser without the desktop bridge', async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({providers:[{provide:DESKTOP_UPDATE_RUNTIME,useValue:{bridge:null,now:()=>now}}]});
    service = TestBed.inject(DesktopUpdateService);
    service.start(); await service.check(true);
    expect(service.supported).toBeFalse(); expect(service.show()).toBeFalse();
  });
  it('starts once, receives progress, and removes its bridge listener on destroy', async () => {
    const unsubscribe = jasmine.createSpy('unsubscribe');
    let listener!: (value: DesktopUpdateState) => void;
    bridge.onUpdateState.and.callFake((callback) => { listener = callback; return unsubscribe; });
    service.start(); service.start(); await service.check();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    listener({phase:'downloading',progress:52});
    expect(service.state().progress).toBe(52);
    TestBed.resetTestingModule();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it('coalesces checks, throttles background checks and always allows a manual check', async () => {
    const first = service.check(); const second = service.check();
    expect(first).toBe(second); await first;
    now += 1000; await service.check();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(1);
    await service.check(true);
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(2);
    now += 6 * 60 * 60 * 1000; await service.check();
    expect(bridge.checkForUpdate).toHaveBeenCalledTimes(3);
  });
  it('keeps a failed check retryable without claiming the current version is up to date', async () => {
    bridge.checkForUpdate.and.rejectWith(new Error('UPDATE_NETWORK'));
    await service.check();
    expect(service.checkResult()).toBe('error');
    expect(service.checking()).toBeFalse();
    bridge.checkForUpdate.and.resolveTo(available);
    await service.check(true);
    expect(service.show()).toBeTrue();
  });
  it('never downloads or installs while locked, during a call, or in the background', async () => {
    await service.check();
    service.safe.set(false); await service.download();
    service.safe.set(true); service.foreground.set(false); await service.download();
    expect(bridge.downloadUpdate).not.toHaveBeenCalled();
    service.state.set({phase:'ready',progress:100}); await service.install();
    service.foreground.set(true); service.safe.set(false); await service.install();
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    expect(service.show()).toBeFalse();
  });
  it('requires a separate explicit install after downloading and prevents duplicate downloads', async () => {
    await service.check();
    let finish!: (value: any) => void;
    bridge.downloadUpdate.and.returnValue(new Promise(resolve => finish = resolve));
    const first = service.download(); await service.download();
    expect(bridge.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(bridge.installUpdate).not.toHaveBeenCalled();
    finish({...available,status:'downloaded'}); await first;
    expect(service.state().phase).toBe('ready');
    await service.install();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });
  it('keeps the update pending when the user selects later or a call hides the dialog', async () => {
    await service.check(); service.dismiss();
    expect(service.show()).toBeFalse(); expect(service.release()?.version).toBe('4.2.0');
    await service.check(true); expect(service.show()).toBeTrue();
    service.safe.set(false); expect(service.show()).toBeFalse();
    service.safe.set(true); expect(service.show()).toBeTrue();
  });
  it('does not present a broken download as ready', async () => {
    await service.check(); bridge.downloadUpdate.and.rejectWith(new Error('UPDATE_HASH_MISMATCH'));
    await service.download();
    expect(service.state().phase).toBe('error');
    await service.install(); expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it('shows a genuinely newer release after an older release was postponed', async () => {
    await service.check(); service.dismiss();
    bridge.checkForUpdate.and.resolveTo({...available,version:'4.3.0'});
    now += 6 * 60 * 60 * 1000;
    await service.check();
    expect(service.release()?.version).toBe('4.3.0');
    expect(service.show()).toBeTrue();
  });
});
