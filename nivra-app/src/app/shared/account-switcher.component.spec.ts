import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AccountSwitcherComponent } from './account-switcher.component';
import { AuthService } from '../core/services/auth.service';
import { CallsService } from '../core/services/calls.service';
import { TranslateService } from '../core/services/translate.service';
import { AccountSessionSummary } from '../core/services/account-sessions.service';

describe('account switcher', () => {
  let fixture: ComponentFixture<AccountSwitcherComponent>;
  let component: AccountSwitcherComponent;
  let auth: any;
  let calls: { activeCall: ReturnType<typeof signal<any>>; resumableCall: ReturnType<typeof signal<any>> };
  const alice: AccountSessionSummary = { id: 'alice', alias: 'alice', displayName: 'Alice', profilePhotoDataUrl: null, active: true };
  const bob: AccountSessionSummary = { id: 'bob', alias: 'bob', displayName: 'Bob', profilePhotoDataUrl: null, active: false };

  beforeEach(async () => {
    auth = { savedAccounts: signal([alice, bob]), accountsBusy: signal(false), accountError: signal(''),
      switchAccount: jasmine.createSpy('switch').and.resolveTo(true), beginAddAccount: jasmine.createSpy('add').and.resolveTo(),
      removeAccount: jasmine.createSpy('remove').and.resolveTo() };
    calls = { activeCall: signal(null), resumableCall: signal(null) };
    await TestBed.configureTestingModule({ imports: [AccountSwitcherComponent], providers: [
      { provide: AuthService, useValue: auth }, { provide: CallsService, useValue: calls },
      { provide: TranslateService, useValue: { instant: (key: string, fallback: string) => fallback || key } },
    ] }).compileComponents();
    fixture = TestBed.createComponent(AccountSwitcherComponent); component = fixture.componentInstance; fixture.detectChanges();
  });
  afterEach(() => { fixture.destroy(); TestBed.resetTestingModule(); });

  it('renders two profiles, exposes active state, and prevents a third slot', () => {
    expect(fixture.nativeElement.querySelectorAll('.account-select').length).toBe(2);
    expect(fixture.nativeElement.querySelectorAll('.account-select')[0].getAttribute('aria-pressed')).toBe('true');
    expect(fixture.nativeElement.querySelector('.add-account')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('2/2');
  });

  it('switches with a saved ID and does not ask for credentials', async () => {
    await component.switchAccount(bob);
    expect(auth.switchAccount).toHaveBeenCalledOnceWith('bob');
    expect(fixture.nativeElement.querySelector('input')).toBeNull();
  });

  it('exposes add when a slot is available and confirms removal of the chosen profile', async () => {
    auth.savedAccounts.set([alice]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.add-account')).not.toBeNull();
    await component.addAccount(); expect(auth.beginAddAccount).toHaveBeenCalledTimes(1);
    await component.removeAccount(alice); expect(auth.removeAccount).not.toHaveBeenCalled();
    component.removing.set('alice'); await component.removeAccount(alice);
    expect(auth.removeAccount).toHaveBeenCalledOnceWith('alice');
  });

  it('blocks switching, adding and removing the active account during an active or resumable call', async () => {
    for (const state of [calls.activeCall, calls.resumableCall]) {
      state.set({ id: 'call' }); auth.savedAccounts.set([alice]); fixture.detectChanges();
      await component.switchAccount(bob); await component.addAccount();
      component.removing.set('alice'); await component.removeAccount(alice);
      expect(fixture.nativeElement.querySelector('.add-account').disabled).toBeTrue();
      state.set(null);
    }
    expect(auth.switchAccount).not.toHaveBeenCalled(); expect(auth.beginAddAccount).not.toHaveBeenCalled();
    expect(auth.removeAccount).not.toHaveBeenCalled();
  });

  it('allows removing an inactive account while another account is in a call', async () => {
    calls.activeCall.set({ id: 'call' }); component.removing.set('bob'); await component.removeAccount(bob);
    expect(auth.removeAccount).toHaveBeenCalledOnceWith('bob');
  });

  it('formats old private IDs without exposing the generated legacy alias', () => {
    const legacy = { ...alice, alias: 'n_0123456789abcdef01234567', displayName: null, nivraNumber: '123456789', isPrivateAccount: true };
    expect(component.label(legacy)).toBe('Nivra 123 456 789');
    expect(component.subtitle(legacy)).toBe('123 456 789');
  });
});
