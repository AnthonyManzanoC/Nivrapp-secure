import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { AccountViewBoundaryService } from './account-view-boundary.service';
import { AuthService } from './auth.service';

describe('account view isolation', () => {
  const owner = (id: string, device = 'phone') => ({ user: { id }, device: { id: device } });
  let session: ReturnType<typeof signal<any>>;
  let boundary: AccountViewBoundaryService;
  beforeEach(() => {
    session = signal<any>(owner('first'));
    spyOn(window, 'requestAnimationFrame').and.callFake(callback => window.setTimeout(() => callback(0), 16));
    spyOn(window, 'cancelAnimationFrame').and.callFake(id => window.clearTimeout(id));
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { session } }] });
    boundary = TestBed.inject(AccountViewBoundaryService);
    TestBed.flushEffects();
  });
  it('hides the former account synchronously before effects run, then permits the new route', fakeAsync(() => {
    expect(boundary.ready()).toBeTrue();
    session.set(owner('second'));
    expect(boundary.ready()).toBeFalse();
    TestBed.flushEffects();
    expect(boundary.ready()).toBeFalse();
    tick(16);
    expect(boundary.ready()).toBeTrue();
  }));
  it('does not detach private views for a normal profile or token refresh', () => {
    session.set({ ...owner('first'), user: { id: 'first', displayName: 'Otro nombre' }, tokens: { accessToken: 'refreshed' } });
    expect(boundary.ready()).toBeTrue();
  });
  it('cancels an obsolete transition during logout and a quick account switch', fakeAsync(() => {
    session.set(null); TestBed.flushEffects();
    tick(8);
    session.set(owner('second')); TestBed.flushEffects();
    tick(8);
    expect(boundary.ready()).toBeFalse();
    tick(8);
    expect(boundary.ready()).toBeTrue();
  }));
  it('detaches on a different device identity for the same account', () => {
    session.set(owner('first', 'replacement-device'));
    expect(boundary.ready()).toBeFalse();
  });
});
