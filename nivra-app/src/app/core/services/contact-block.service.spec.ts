import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { ContactBlockService } from './contact-block.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { ChatService } from './chat.service';

describe('account contact blocking', () => {
  const account = (id: string) => ({ user: { id }, device: { id: `device-${id}` } } as any);
  let session: ReturnType<typeof signal<any>>;
  let api: { get: jasmine.Spy; put: jasmine.Spy };
  let events: Subject<any>;
  let service: ContactBlockService;
  let generation: ReturnType<typeof signal<number>>;
  const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

  beforeEach(async () => {
    for (const id of ['alice', 'carol']) localStorage.removeItem(`nivra.contactBlocks.v1.${id}`);
    session = signal(account('alice')); generation = signal(1); events = new Subject();
    api = { get: jasmine.createSpy().and.returnValue(of([])), put: jasmine.createSpy() };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: { session, sessionGeneration: generation } }, { provide: NivraApiService, useValue: api },
      { provide: SignalrService, useValue: { events$: events } },
    ] });
    service = TestBed.inject(ContactBlockService); TestBed.flushEffects(); await settle();
  });
  afterEach(() => { TestBed.resetTestingModule(); for (const id of ['alice', 'carol']) localStorage.removeItem(`nivra.contactBlocks.v1.${id}`); });

  it('confirms a block on the server before changing the account UI or cache', async () => {
    const response = new Subject<any>(); api.put.and.returnValue(response);
    const saving = service.setBlocked('bob', true); await settle();
    expect(service.isBlocked('bob')).toBeFalse();
    response.next({ userId: 'bob', blocked: true }); response.complete(); await saving;
    expect(service.isBlocked('bob')).toBeTrue();
    expect(api.put).toHaveBeenCalledWith('/contacts/bob/block', { blocked: true });
    expect(JSON.parse(localStorage.getItem('nivra.contactBlocks.v1.alice')!)).toEqual(['bob']);
  });

  it('does not claim success or erase a prior block when the network edit fails', async () => {
    api.get.and.returnValue(of(['bob'])); await service.refresh();
    api.put.and.returnValue(throwError(() => new Error('offline')));
    await expectAsync(service.setBlocked('bob', false)).toBeRejectedWithError('offline');
    expect(service.isBlocked('bob')).toBeTrue();
  });

  it('hides another account’s list immediately and rejects its delayed mutation', async () => {
    api.get.and.returnValue(of(['bob'])); await service.refresh();
    const response = new Subject<any>(); api.put.and.returnValue(response);
    const saving = service.setBlocked('bob', false); const rejected = expectAsync(saving).toBeRejectedWithError(/cuenta cambió/); await settle();
    session.set(account('carol'));
    expect(service.blockedUserIds()).toEqual([]);
    api.get.and.returnValue(of(['dave'])); TestBed.flushEffects(); await settle();
    response.next({ userId: 'bob', blocked: false }); response.complete(); await rejected;
    expect(service.blockedUserIds()).toEqual(['dave']);
    expect(JSON.parse(localStorage.getItem('nivra.contactBlocks.v1.alice')!)).toEqual(['bob']);
  });

  it('does not let an older refresh overwrite a confirmed edit', async () => {
    const snapshot = new Subject<string[]>(); api.get.and.returnValue(snapshot);
    const refresh = service.refresh();
    api.put.and.returnValue(of({ userId: 'bob', blocked: true })); await service.setBlocked('bob', true);
    snapshot.next([]); snapshot.complete(); await refresh;
    expect(service.isBlocked('bob')).toBeTrue();
  });

  it('rejects an old operation even after returning to the same account and device', async () => {
    const response = new Subject<any>(); api.put.and.returnValue(response);
    const saving = service.setBlocked('bob', true); const rejected = expectAsync(saving).toBeRejectedWithError(/cuenta cambió/); await settle();
    generation.update(value => value + 2); session.set(account('alice')); TestBed.flushEffects(); await settle();
    response.next({ userId: 'bob', blocked: true }); response.complete(); await rejected;
    expect(service.isBlocked('bob')).toBeFalse();
  });

  it('serializes opposite edits and preserves blocks for other contacts', async () => {
    const first = new Subject<any>(); let count = 0;
    api.put.and.callFake((path: string, body: any) => ++count === 1 ? first : of({ userId: path.includes('bob') ? 'bob' : 'dave', blocked: body.blocked }));
    const block = service.setBlocked('bob', true); const unblock = service.setBlocked('bob', false); const other = service.setBlocked('dave', true);
    await settle(); expect(api.put.calls.count()).toBe(1);
    first.next({ userId: 'bob', blocked: true }); first.complete(); await Promise.all([block, unblock, other]);
    expect(service.blockedUserIds()).toEqual(['dave']);
  });

  it('refreshes the private list on a remote edit and reconnect', async () => {
    api.get.and.returnValue(of(['bob'])); events.next({ type: 'contacts.blocksChanged' }); await settle();
    expect(service.isBlocked('bob')).toBeTrue();
    api.get.and.returnValue(of([])); events.next({ type: 'reconnected' }); await settle();
    expect(service.isBlocked('bob')).toBeFalse();
  });

  it('rejects mismatched server acknowledgements', async () => {
    api.put.and.returnValue(of({ userId: 'different', blocked: true }));
    await expectAsync(service.setBlocked('bob', true)).toBeRejectedWithError(/confirmar/);
    expect(service.isBlocked('bob')).toBeFalse();
  });

  it('applies a contact block to duplicate direct threads without blocking their shared group', () => {
    const chat: any = Object.create(ChatService.prototype);
    chat.auth = { session }; chat.contactBlocks = service;
    chat.conversations = signal([
      { id: 'one', type: 'Direct', participants: [{ userId: 'alice' }, { userId: 'bob' }] },
      { id: 'two', type: 'Direct', participants: [{ userId: 'alice' }, { userId: 'bob' }] },
      { id: 'group', type: 'Group', participants: [{ userId: 'alice' }, { userId: 'bob' }, { userId: 'carol' }] },
    ]);
    spyOn(service, 'isBlocked').and.callFake(id => id === 'bob');
    expect(chat.isConversationBlocked('one')).toBeTrue(); expect(chat.isConversationBlocked('two')).toBeTrue();
    expect(chat.isConversationBlocked('group')).toBeFalse();
  });
});
