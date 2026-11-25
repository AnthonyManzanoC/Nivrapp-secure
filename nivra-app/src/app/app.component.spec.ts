import { CUSTOM_ELEMENTS_SCHEMA, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';

import { AppComponent } from './app.component';
import { WEB_LAUNCH_RUNTIME } from './core/services/web-launch.service';
import { Capacitor, SystemBarsStyle } from '@capacitor/core';
import { Style } from '@capacitor/status-bar';

describe('AppComponent', () => {
  it('keeps Android navigation icons contrasted with both story and page surfaces', async () => {
    spyOn(Capacitor, 'getPlatform').and.returnValue('android');
    const navigation = jasmine.createSpy('navigation').and.resolveTo();
    const edgeStyle = jasmine.createSpy('edgeToEdgeStyle').and.resolveTo();
    const show = jasmine.createSpy('show').and.resolveTo();
    const app: any = Object.assign(Object.create(AppComponent.prototype), {
      systemBarUpdate: Promise.resolve(), systemBarEpoch: 0,
      nativeSystemBars: {
        setOverlaysWebView: async () => {},
        setStyle: async () => {},
        setBackgroundColor: async () => { throw new Error('Transparent edge-to-edge bars'); },
        show,
      },
      nativeEdgeBars: { setStyle: edgeStyle },
      nativeDevice: { configureNavigationBar: navigation },
    });
    await app.configureNativeSystemBars({ color: '#070b0d', style: Style.Dark, ensureVisible: true });
    expect(navigation).toHaveBeenCalledWith('#070b0d', false);
    expect(edgeStyle).toHaveBeenCalledWith({ style: SystemBarsStyle.Dark });
    await app.configureNativeSystemBars({ color: '#f8fafc', style: Style.Light });
    expect(navigation).toHaveBeenCalledWith('#f8fafc', true);
    expect(edgeStyle).toHaveBeenCalledWith({ style: SystemBarsStyle.Light });
    expect(show).toHaveBeenCalledTimes(1);
  });
  it('matches Welcome system icons and background to the resolved theme', () => {
    const app = Object.create(AppComponent.prototype) as any;
    expect(app.nativeStatusBarSurface(false, '/welcome', false)).toEqual({ color: '#0d1815', style: Style.Dark });
    expect(app.nativeStatusBarSurface(true, '/welcome?language=es', false)).toEqual({ color: '#f7f8f2', style: Style.Light });
  });

  it('serializes native system bar changes so an older dark update cannot win after switching to light', async () => {
    let finish!: () => void;
    const overlay = jasmine.createSpy('setOverlaysWebView').and.returnValues(new Promise<void>(resolve => finish = resolve), Promise.resolve());
    const style = jasmine.createSpy('setStyle').and.resolveTo();
    const background = jasmine.createSpy('setBackgroundColor').and.resolveTo();
    const app = Object.assign(Object.create(AppComponent.prototype), { systemBarUpdate: Promise.resolve(), systemBarEpoch: 0,
      nativeSystemBars: { setOverlaysWebView: overlay, setStyle: style, setBackgroundColor: background } }) as any;
    const dark = app.configureNativeSystemBars({ color: '#0d1815', style: Style.Dark });
    await Promise.resolve(); await Promise.resolve();
    const light = app.configureNativeSystemBars({ color: '#f7f8f2', style: Style.Light });
    finish(); await Promise.all([dark, light]);
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(style).toHaveBeenCalledOnceWith({ style: Style.Light });
    expect(background).toHaveBeenCalledOnceWith({ color: '#f7f8f2' });
  });

  it('defers a web version reload while an unfocused chat draft or modal is open', () => {
    const app: any = Object.assign(Object.create(AppComponent.prototype), {
      auth: { busy: () => false, addingAccount: () => false, accountsBusy: () => false }, calls: { activeCall: () => null, resumableCall: () => null },
      chat: { uploading: () => false, deviceHistory: { approvingRequestId: () => null, state: () => 'idle', pendingRequests: () => [] } },
    });
    const draft = document.createElement('textarea');
    const modal = Object.assign(document.createElement('ion-modal'), { isOpen: false });
    document.body.append(draft, modal);
    try {
      expect(app.canApplyWebUpdate()).toBeTrue();
      draft.value = 'Mensaje que todavía no envié';
      expect(app.canApplyWebUpdate()).toBeFalse();
      draft.value = ''; modal.isOpen = true;
      expect(app.canApplyWebUpdate()).toBeFalse();
      modal.isOpen = false;
      expect(app.canApplyWebUpdate()).toBeTrue();
    } finally { draft.remove(); modal.remove(); }
  });

  it('resumes HTTP chat updates without waiting for the biometric bridge or realtime handshake', async () => {
    const sync = jasmine.createSpy('sync').and.resolveTo();
    const biometry = jasmine.createSpy('biometry').and.returnValue(new Promise(() => undefined));
    const app: any = Object.assign(Object.create(AppComponent.prototype), {
      appLock: { refreshBiometryAvailability: biometry },
      auth: { isAuthenticated: () => true, sessionGeneration: () => 1 },
      destroyRef: { destroyed: false }, foreground: () => true,
      localHistory: { retryNativeStorage: jasmine.createSpy('open').and.resolveTo(true) },
      realtime: { connect: jasmine.createSpy('connect').and.returnValue(new Promise(() => undefined)) },
      chat: { resumeSoftSync: sync }, webLaunch: { checkForUpdate: jasmine.createSpy('update').and.resolveTo() },
    });
    await app.handleAppResume();
    expect(biometry).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        provideHttpClient(),
        provideRouter([]),
        { provide: WEB_LAUNCH_RUNTIME, useValue: { isWeb: false, sensitiveRoute: () => false } },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();
  });

  it('routes native recovery links with their token fragment', () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    const navigate = spyOn(TestBed.inject(Router), 'navigateByUrl').and.resolveTo(true);
    (app as any).handleAppUrlOpen('https://nivrapp-secure.vercel.app/recover#token=abc&purpose=verify-email');
    expect(navigate).toHaveBeenCalledWith('/recover#token=abc&purpose=verify-email');
    navigate.calls.reset();
    (app as any).handleAppUrlOpen('https://example.test/recover#token=abc');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('opens native group and community invitations only from canonical HTTPS links with a valid private fragment',()=>{
    const app=Object.create(AppComponent.prototype) as any,navigate=jasmine.createSpy('navigate').and.resolveTo(true);app.router={navigateByUrl:navigate};
    const code='a'.repeat(43);app.handleAppUrlOpen('https://nivrapp-secure.vercel.app/group/invite#'+code);
    expect(navigate).toHaveBeenCalledOnceWith('/group/invite#'+code);navigate.calls.reset();
    for(const url of ['https://example.test/group/invite#'+code,'http://nivrapp-secure.vercel.app/group/invite#'+code,'https://nivrapp-secure.vercel.app/group/invite#invalid','https://nivrapp-secure.vercel.app:8443/group/invite#'+code])app.handleAppUrlOpen(url);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('coalesces overlapping native resume events', async () => {
    const app = TestBed.createComponent(AppComponent).componentInstance;
    let complete!: () => void;
    const resume = spyOn<any>(app, 'resumeExistingSession').and.returnValue(new Promise<void>(resolve => complete = resolve));
    const first = (app as any).handleAppResume();
    const second = (app as any).handleAppResume();
    expect(first).toBe(second); expect(resume).toHaveBeenCalledTimes(1);
    complete(); await first;
    await (app as any).handleAppResume();
    expect(resume).toHaveBeenCalledTimes(2);
  });

  it('lets a new account resume while a sync for the previous account is still pending', async () => {
    const sessionGeneration = signal(1);
    const app = Object.assign(Object.create(AppComponent.prototype), {
      auth: { sessionGeneration },
      appLock: { refreshBiometryAvailability: async () => undefined },
      webLaunch: { checkForUpdate: async () => undefined },
    }) as AppComponent;
    let finishOld!: () => void;
    let finishCurrent!: () => void;
    spyOn<any>(app, 'resumeExistingSession').and.returnValues(
      new Promise<void>(resolve => finishOld = resolve),
      new Promise<void>(resolve => finishCurrent = resolve),
    );
    const previous = (app as any).handleAppResume();
    sessionGeneration.set(2);
    const current = (app as any).handleAppResume();
    expect(previous).not.toBe(current);
    finishOld(); await previous;
    expect((app as any).handleAppResume()).toBe(current);
    finishCurrent(); await current;
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('keeps daily presentation away from calls, vaults, sharing and access links', () => {
    const app = TestBed.createComponent(AppComponent).componentInstance as any;
    for (const url of ['/app/chats', '/app/chats/chat_123', '/app/account?theme=light', '/app/world']) {
      expect(app.canPresentDailyLaunch(url)).withContext(url).toBeTrue();
    }
    for (const url of ['/', '/auth', '/recover#token=secret', '/app/calls', '/app/share?share=1', '/app/vault', '/invite/abc', '/app/chats/123/edit']) {
      expect(app.canPresentDailyLaunch(url)).withContext(url).toBeFalse();
    }
  });

  it('makes routed content inert while locked and restores it after unlocking', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    fixture.componentInstance.appLock.isLocked.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-router-outlet').hasAttribute('inert')).toBeTrue();
    const shell = fixture.nativeElement.querySelector('ion-app');
    expect(shell.hasAttribute('inert')).toBeTrue();
    expect(shell.getAttribute('aria-hidden')).toBe('true');
    expect(shell.contains(fixture.nativeElement.querySelector('app-lock-screen'))).toBeFalse();
    fixture.componentInstance.appLock.isLocked.set(false);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ion-router-outlet').hasAttribute('inert')).toBeFalse();
    expect(shell.hasAttribute('inert')).toBeFalse();
  });

  it('does not cover the public web with the version check', () => {
    const fixture = TestBed.createComponent(AppComponent);
    fixture.componentInstance.webLaunch.checking.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.daily-launch')).toBeNull();
    expect(fixture.nativeElement.querySelector('ion-router-outlet').hasAttribute('inert')).toBeFalse();
  });

  it('locks a configured session when hidden and resumes it without a launch presentation', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const lock = spyOn(fixture.componentInstance.appLock, 'lock');
    const request = spyOn(fixture.componentInstance.dailyLaunch, 'requestPresentation');
    const resume = spyOn<any>(fixture.componentInstance, 'handleAppResume').and.resolveTo();
    const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(lock).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    visibility.and.returnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(resume).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    fixture.destroy();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('resumes a browser page restored from history without treating the original load as a resume', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const resume = spyOn<any>(fixture.componentInstance, 'handleAppResume').and.resolveTo();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }));
    expect(resume).not.toHaveBeenCalled();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(resume).toHaveBeenCalledTimes(1);
    fixture.destroy();
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    expect(resume).toHaveBeenCalledTimes(1);
  });

});
