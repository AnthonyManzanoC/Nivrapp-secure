import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { BroadcastDispatch, BroadcastListVm, BroadcastService } from '../../core/services/broadcast.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { BroadcastsPage } from './broadcasts.page';

describe('broadcast list UI intent and recovery', () => {
  let page: BroadcastsPage;
  let service: any;
  let social: any;
  let session: ReturnType<typeof signal<any>>;
  const list = (id = 'one', recipients = ['bob']): BroadcastListVm => ({ id, name: id, recipientUserIds: recipients, recipientCount: recipients.length, revision: 1, locked: false, updatedAt: '2026-10-25T12:00:00Z' });
  const contact = (userId: string) => ({ userId, alias: userId, displayName: userId, isFavorite: false, isMutualContact: false, createdAt: '2026-10-25T12:00:00Z' });
  const dispatch = (listId = 'one'): BroadcastDispatch => ({ operationId: 'existing-operation', listId, text: 'Mensaje', results: [{ userId: 'bob', status: 'failed' }] });
  beforeEach(() => {
    session = signal({ user: { id: 'alice' }, device: { id: 'phone' } });
    service = {
      lists: signal([list(), list('two', ['carol'])]), loading: signal(false), saving: signal(false), sending: signal(false), error: signal(''), progress: signal(null), lastDispatch: signal<BroadcastDispatch | null>(null),
      load: jasmine.createSpy().and.resolveTo(), save: jasmine.createSpy().and.callFake(async () => { const created = list('new'); service.lists.update((items: BroadcastListVm[]) => [...items, created]); return created; }),
      remove: jasmine.createSpy().and.resolveTo(), sendText: jasmine.createSpy().and.resolveTo({ ...dispatch(), results: [{ userId: 'bob', status: 'sent' }] }),
      retryFailed: jasmine.createSpy().and.resolveTo({ ...dispatch(), results: [{ userId: 'bob', status: 'sent' }] }),
      clearEphemeralDispatch: jasmine.createSpy(),
    };
    social = { contacts: signal([contact('bob'), contact('carol')]), contactsLoading: signal(false), loadConnections: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ imports: [BroadcastsPage], providers: [provideIonicAngular({ animated: false }),
      { provide: BroadcastService, useValue: service }, { provide: SocialService, useValue: social },
      { provide: AuthService, useValue: { session } }, { provide: Router, useValue: { navigateByUrl: jasmine.createSpy().and.resolveTo(true) } },
      { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback } },
    ] });
    page = TestBed.runInInjectionContext(() => new BroadcastsPage()); TestBed.flushEffects();
  });
  afterEach(() => { page.ngOnDestroy(); TestBed.resetTestingModule(); });

  it('loads, opens and saves a list without automatically emitting a message', async () => {
    await page.ngOnInit(); page.openEditor(); page.name = 'Familia'; page.toggleRecipient('bob'); await page.save();
    expect(service.save).toHaveBeenCalledOnceWith('Familia', ['bob'], undefined);
    expect(service.sendText).not.toHaveBeenCalled(); expect(service.retryFailed).not.toHaveBeenCalled();
    expect(page.selectedList()?.id).toBe('new');
  });

  it('allows only saved contacts and enforces the 256 recipient limit', () => {
    social.contacts.set(Array.from({ length: 260 }, (_, index) => contact(`user-${index}`)));
    page.openEditor(); page.toggleRecipient('stranger'); page.toggleRecipient('alice');
    expect(page.selectedRecipients()).toEqual([]);
    for (let index = 0; index < 260; index++) page.toggleRecipient(`user-${index}`);
    expect(page.selectedRecipients().length).toBe(256);
    page.toggleRecipient('user-0'); page.toggleRecipient('user-259');
    expect(page.selectedRecipients().length).toBe(256); expect(page.selectedRecipients()).toContain('user-259');
  });

  it('does not silently drop unavailable recipients from an edited list', async () => {
    const existing = list('missing', ['bob', 'gone']); service.lists.set([existing]);
    page.openEditor(existing); await page.save();
    expect(service.save).not.toHaveBeenCalled(); expect(page.selectedRecipients()).toContain('gone');
    page.removeMissingRecipients(); await page.save();
    expect(service.save).toHaveBeenCalledWith('missing', ['bob'], existing);
  });

  it('selects the latest VM by ID after the service changes a revision during dispatch', () => {
    page.select(service.lists()[0]);
    service.lists.set([{ ...list(), revision: 3, name: 'Actualizada' }]);
    expect(page.selectedList()?.revision).toBe(3); expect(page.selectedList()?.name).toBe('Actualizada');
  });

  it('warns before editing a list whose pending delivery tracking would be replaced', () => {
    service.lastDispatch.set(dispatch());
    const confirm = spyOn(window, 'confirm').and.returnValue(false);
    page.openEditor(service.lists()[0]);
    expect(confirm).toHaveBeenCalled();
    expect(page.editorOpen).toBeFalse();
    expect(service.lastDispatch()?.results[0].status).toBe('failed');
  });

  it('refuses to save an editor based on an outdated revision', async () => {
    const existing = service.lists()[0]; page.openEditor(existing);
    service.lists.set([{ ...existing, revision: 2 }]); await page.save();
    expect(page.staleEditor()).toBeTrue(); expect(service.save).not.toHaveBeenCalled();
  });

  it('prevents a double send while allowing the user to read another list', async () => {
    let finish!: (value: BroadcastDispatch) => void;
    service.sendText.and.returnValue(new Promise(resolve => finish = resolve));
    page.select(service.lists()[0]); page.draft = 'Mensaje';
    const sending = page.send(); await page.send();
    expect(service.sendText).toHaveBeenCalledTimes(1);
    page.select(service.lists()[1]); page.draft = 'Otro borrador';
    finish({ ...dispatch(), results: [{ userId: 'bob', status: 'sent' }] }); await sending;
    expect(page.selectedId()).toBe('two'); expect(page.draft).toBe('Otro borrador');
  });

  it('resumes the existing operation explicitly instead of creating a duplicate message after failure', async () => {
    page.select(service.lists()[0]); page.draft = 'Mensaje'; service.lastDispatch.set(dispatch());
    await page.send(); expect(service.sendText).not.toHaveBeenCalled();
    await page.retryFailed();
    expect(service.retryFailed).toHaveBeenCalledOnceWith(); expect(page.draft).toBe('');
  });

  it('offers explicit resume for a restored pending operation without sending on load', async () => {
    service.lastDispatch.set({ ...dispatch(), results: [{ userId: 'bob', status: 'pending' }] });
    await page.ngOnInit();
    expect(page.pendingCount()).toBe(1); expect(page.remainingCount()).toBe(1);
    expect(service.sendText).not.toHaveBeenCalled(); expect(service.retryFailed).not.toHaveBeenCalled();
    await page.retryFailed(); expect(service.retryFailed).toHaveBeenCalledTimes(1);
  });

  it('does not replace incomplete tracking with a new dispatch when the user cancels', async () => {
    spyOn(window, 'confirm').and.returnValue(false);
    service.lastDispatch.set(dispatch()); page.select(service.lists()[1]); page.draft = 'Nuevo mensaje';
    await page.send(); expect(service.sendText).not.toHaveBeenCalled();
  });

  it('does not apply a late save result to another account, including an account switch back', async () => {
    let finish!: (value: BroadcastListVm) => void;
    service.save.and.returnValue(new Promise(resolve => finish = resolve));
    page.openEditor(); page.name = 'Mi lista'; page.toggleRecipient('bob'); const saving = page.save();
    session.set({ user: { id: 'other' }, device: { id: 'other' } }); TestBed.flushEffects();
    session.set({ user: { id: 'alice' }, device: { id: 'phone' } }); TestBed.flushEffects();
    finish(list('old-account')); await saving;
    expect(page.selectedId()).toBe(''); expect(page.notice).toBe('');
  });

  it('requires local confirmation before deleting a list', async () => {
    spyOn(window, 'confirm').and.returnValue(false); await page.remove(service.lists()[0]); expect(service.remove).not.toHaveBeenCalled();
  });

  it('renders a locked list without a composer or an implicit recovery request', () => {
    service.lists.set([{ ...list(), locked: true, recipientUserIds: [] }]);
    const fixture = TestBed.createComponent(BroadcastsPage); fixture.componentInstance.select(service.lists()[0]); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.locked-copy')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('ion-textarea')).toBeNull();
    expect(service.sendText).not.toHaveBeenCalled(); fixture.destroy();
  });

  it('renders actual recipient result states and the resume action for a recovered pending job', () => {
    service.lastDispatch.set({ ...dispatch(), results: [{ userId: 'bob', status: 'sent' }, { userId: 'carol', status: 'pending' }] });
    const fixture = TestBed.createComponent(BroadcastsPage); fixture.detectChanges();
    const statuses = [...fixture.nativeElement.querySelectorAll('.result-status')].map((element: any) => element.textContent.trim());
    expect(statuses).toEqual(['Enviado', 'Pendiente']);
    expect(fixture.nativeElement.querySelector('.retry-footer').textContent).toContain('Continuar pendientes');
    expect(service.sendText).not.toHaveBeenCalled(); fixture.destroy();
  });
});
