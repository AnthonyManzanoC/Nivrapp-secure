import { CUSTOM_ELEMENTS_SCHEMA } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { Router, provideRouter } from '@angular/router';
import { TestBed } from '@angular/core/testing';

import { AppComponent } from './app.component';
import { WEB_LAUNCH_RUNTIME } from './core/services/web-launch.service';

describe('AppComponent', () => {

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

  it('locks a configured web or desktop session when hidden and requests daily presentation on return', () => {
    const fixture = TestBed.createComponent(AppComponent);
    const lock = spyOn(fixture.componentInstance.appLock, 'lock');
    const request = spyOn(fixture.componentInstance.dailyLaunch, 'requestPresentation');
    const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(lock).toHaveBeenCalledTimes(1);
    expect(request).not.toHaveBeenCalled();
    visibility.and.returnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);
    fixture.destroy();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(request).toHaveBeenCalledTimes(1);
  });

});
