import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router, convertToParamMap } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { TranslateService } from '../../core/services/translate.service';
import { ContactInvitePage } from './contact-invite.page';

describe('Shared contact invitation continuity', () => {
  let auth: any, chat: any, router: any, alias: string, previous: string | null;
  beforeEach(async () => {
    previous = localStorage.getItem('nivra.pendingContactAlias');
    localStorage.removeItem('nivra.pendingContactAlias');
    alias = 'Alice';
    auth = { session: signal<any>(null), sessionGeneration: signal(0), isAuthenticated: () => !!auth.session(), ensureSessionRestored: jasmine.createSpy().and.resolveTo(false) };
    chat = { searchPeople: jasmine.createSpy().and.resolveTo([{ id: 'peer', alias: 'alice' }]), createDirectConversation: jasmine.createSpy().and.resolveTo({ id: 'chat-one' }) };
    router = { navigateByUrl: jasmine.createSpy().and.resolveTo(true), navigate: jasmine.createSpy().and.resolveTo(true) };
    await TestBed.configureTestingModule({ imports: [ContactInvitePage], providers: [
      { provide: AuthService, useValue: auth }, { provide: ChatService, useValue: chat },
      { provide: Router, useValue: router },
      { provide: ActivatedRoute, useValue: { snapshot: { get queryParamMap() { return convertToParamMap({ alias }); } } } },
      { provide: TranslateService, useValue: { instant: (_: string, fallback: string) => fallback } },
    ] }).overrideComponent(ContactInvitePage, { set: { template: '', imports: [] } }).compileComponents();
  });
  afterEach(() => {
    if (previous === null) localStorage.removeItem('nivra.pendingContactAlias');
    else localStorage.setItem('nivra.pendingContactAlias', previous);
    TestBed.resetTestingModule();
  });
  const enter = () => TestBed.createComponent(ContactInvitePage).componentInstance.ngOnInit();
  it('waits for a cold-start session and opens the exact shared contact', async () => {
    auth.ensureSessionRestored.and.callFake(async () => { auth.session.set({ user: { id: 'owner', alias: 'bob' } }); return true; });
    await enter();
    expect(chat.searchPeople).toHaveBeenCalledWith('alice');
    expect(router.navigate).toHaveBeenCalledWith(['/app/chats', 'chat-one']);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });
  it('retains the contact through login or registration without an open redirect', async () => {
    await enter();
    expect(localStorage.getItem('nivra.pendingContactAlias')).toBe('alice');
    expect((AuthService.prototype as any).consumePostAuthUrl.call({})).toBe('/contact?alias=alice');
    expect(router.navigateByUrl).toHaveBeenCalledWith('/auth');
    expect(chat.searchPeople).not.toHaveBeenCalled();
  });
  it('does not create a chat in a different account after a delayed lookup', async () => {
    auth.session.set({ user: { id: 'owner', alias: 'bob' } });
    chat.searchPeople.and.callFake(async () => { auth.session.set({ user: { id: 'other', alias: 'carol' } }); auth.sessionGeneration.update((n: number) => n + 1); return [{ id: 'peer', alias: 'alice' }]; });
    await enter();
    expect(chat.createDirectConversation).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
  });
  it('rejects a malformed invitation before restoring or searching a session', async () => {
    alias = 'https://untrusted.example';
    await enter();
    expect(auth.ensureSessionRestored).not.toHaveBeenCalled();
    expect(chat.searchPeople).not.toHaveBeenCalled();
    expect(router.navigateByUrl).not.toHaveBeenCalled();
  });
});
