import { signal } from '@angular/core';
import { TestBed, fakeAsync, flushMicrotasks, tick } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { ChatMessageVm } from '../../core/models/nivra.models';
import { ChatService } from '../../core/services/chat.service';
import { TranslateService } from '../../core/services/translate.service';
import { ChatDetailPage } from './chat-detail.page';
import { MessagePrivacyBadgeComponent } from './message-privacy-badge.component';

const message = (extra: Partial<ChatMessageVm> = {}): ChatMessageVm => ({
  id: 'private-message', conversationId: 'shared-chat', mine: false, senderUserId: 'peer', at: new Date().toISOString(),
  payload: { type: 'text', text: 'Never retain this text after expiry' }, ...extra,
});

describe('Message privacy indicators', () => {
  beforeEach(() => TestBed.configureTestingModule({ imports: [MessagePrivacyBadgeComponent], providers: [provideIonicAngular(),
    { provide: TranslateService, useValue: { currentLanguage: signal('es'), instant: (_: string, fallback: string) => fallback } },
  ] }));
  it('shows an exact expiration and one-view distinction without copying the private body', () => {
    const fixture = TestBed.createComponent(MessagePrivacyBadgeComponent);
    const at = '2026-11-17T15:30:00.000Z';
    fixture.componentRef.setInput('message', message({ expiresAt: at, deleteAfterRead: true })); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('time')?.getAttribute('datetime')).toBe(at);
    expect(root.querySelector('.expiry')?.getAttribute('title')).toContain('Caduca el');
    expect(root.textContent).toContain('Ver una vez');
    expect(root.textContent).not.toContain('Never retain');
    fixture.componentRef.setInput('message', message({ payload: { type: 'view-once-opened' } })); fixture.detectChanges();
    expect(root.textContent).toContain('Abierto'); expect(root.querySelector('.expiry')).toBeNull();
    fixture.destroy();
  });
  it('does not label ordinary messages or turn an invalid timestamp into a made-up expiration', () => {
    const fixture = TestBed.createComponent(MessagePrivacyBadgeComponent);
    fixture.componentRef.setInput('message', message({ expiresAt: 'invalid' })); fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.privacy-marker').length).toBe(0); fixture.destroy();
  });
});

describe('Viewers respect live expiration, device receipts and account boundaries', () => {
  function harness(item = message()) {
    const session = signal<any>({ user: { id: 'owner' }, device: { id: 'phone' } }), generation = signal(1), locked = signal(false), appLocked = signal(false);
    const messages = signal([item]);
    const chat = { asFile: (payload: any) => payload.type === 'file' ? payload : null,
      isViewOnceOpened: (value: any) => value?.payload.type === 'view-once-opened', isImage: (file: any) => file.mime?.startsWith('image/'),
      isVideo: (file: any) => file.mime?.startsWith('video/'), isAudio: (file: any) => file.mime?.startsWith('audio/'),
      ensureMediaPreview: jasmine.createSpy().and.resolveTo({ fileId: 'file', url: 'blob:private', name: 'private' }),
      markMessageOpened: jasmine.createSpy().and.resolveTo(), fileName: () => 'file',
    };
    const page: any = Object.assign(Object.create(ChatDetailPage.prototype), {
      auth: { session, sessionGeneration: generation }, conversation: () => ({ id: 'shared-chat' }), messages,
      privateChatLocked: () => locked(), privateChats: { appLock: { isContentLocked: appLocked } }, chat,
      viewerRequestEpoch: 0, viewerScope: '', viewerWasListed: false, viewerExpiryTimer: null,
      activeAudioPreview: null, activeAudioMessage: null, activeMediaPreview: null, activeMediaMessage: null,
      activeViewOnceTextMessage: null, downloadingId: null, destroyed: false,
      translate: { instant: (_: string, fallback: string) => fallback },
    });
    return { page, item, session, generation, locked, appLocked, messages, chat };
  }
  afterEach(() => TestBed.resetTestingModule());
  it('removes an open single-view text at its exact TTL without treating expiry as a user read', fakeAsync(() => {
    const h = harness(message({ deleteAfterRead: true, expiresAt: new Date(Date.now() + 1000).toISOString() }));
    void h.page.openViewOnce(h.item);
    flushMicrotasks();
    expect(h.page.activeViewOnceTextMessage).toBe(h.item);
    tick(1000);
    expect(h.page.activeViewOnceTextMessage).toBeNull();
    expect(h.chat.markMessageOpened).not.toHaveBeenCalled();
  }));
  it('closes plaintext when another device reports it opened, or the message is removed', async () => {
    const h = harness(message({ deleteAfterRead: true }));
    await h.page.openViewOnce(h.item);
    h.messages.set([message({ payload: { type: 'view-once-opened' } })]);
    h.page.reconcileMessageViewers(h.messages());
    expect(h.page.activeViewOnceTextMessage).toBeNull();
    expect(h.chat.markMessageOpened).not.toHaveBeenCalled();
    h.messages.set([h.item]); await h.page.openViewOnce(h.item);
    h.messages.set([]); h.page.reconcileMessageViewers([]);
    expect(h.page.activeViewOnceTextMessage).toBeNull();
  });
  it('does not reveal an attachment whose delayed decryption completes after switching accounts in the same chat', async () => {
    const h = harness(message({ payload: { type: 'file', fileId: 'file', mime: 'image/png' } }));
    let resolve!: (value: any) => void;
    h.chat.ensureMediaPreview.and.returnValue(new Promise(done => resolve = done));
    const opening = h.page.openMediaItem(h.item);
    h.session.set({ user: { id: 'other' }, device: { id: 'other-phone' } }); h.generation.update(n => n + 1);
    resolve({ url: 'blob:private' }); await opening;
    expect(h.page.activeMediaPreview).toBeNull();
  });
  it('cancels a pending preview through lock/unlock and never revives an expired payload', async () => {
    const h = harness(message({ payload: { type: 'file', mime: 'audio/webm' }, deleteAfterRead: true }));
    let resolve!: (value: any) => void;
    h.chat.ensureMediaPreview.and.returnValue(new Promise(done => resolve = done));
    const opening = h.page.openAudioPreview(h.item);
    h.appLocked.set(true); h.page.reconcileMessageViewers(h.messages()); h.appLocked.set(false);
    resolve({ url: 'blob:private' }); await opening;
    expect(h.page.activeAudioPreview).toBeNull();
    await h.page.openViewOnce(message({ deleteAfterRead: true, expiresAt: new Date(0).toISOString() }));
    expect(h.page.activeViewOnceTextMessage).toBeNull();
  });
  it('rejects unsupported single-view documents without recursive opening or exporting', async () => {
    const h = harness(message({ deleteAfterRead: true, payload: { type: 'file', fileId: 'file', mime: 'application/zip' } }));
    await h.page.openViewOnce(h.item);
    expect(h.chat.ensureMediaPreview).not.toHaveBeenCalled();
    expect(h.chat.markMessageOpened).not.toHaveBeenCalled();
    expect(h.page.attachmentError).toContain('visor');
  });
  it('does not consume a single-view attachment that failed to download, and grants only its successful retry',async()=>{
    const h=harness(message({deleteAfterRead:true,payload:{type:'file',fileId:'file',mime:'image/png'}}));
    const claim=jasmine.createSpy().and.resolveTo({openedAt:new Date().toISOString(),userId:'owner',deviceId:'phone'});
    (h.chat as any).claimViewOnceOpen=claim;
    h.chat.ensureMediaPreview.and.rejectWith(Error('Offline'));
    await h.page.openMediaItem(h.item);expect(claim).not.toHaveBeenCalled();expect(h.page.activeMediaPreview).toBeNull();
    h.chat.ensureMediaPreview.and.resolveTo({url:'blob:first-valid-view'});
    await h.page.openMediaItem(h.item);expect(claim).toHaveBeenCalledTimes(1);expect(h.page.activeMediaPreview?.url).toBe('blob:first-valid-view');
    await h.page.closeMediaViewer();
  });
  it('shows only the first durable lease, survives its own receipt echo, and cannot reopen after closing offline',async()=>{
    const h=harness(message({deleteAfterRead:true}));
    const openedAt=new Date().toISOString();let consumed=false;
    (h.chat as any).claimViewOnceOpen=jasmine.createSpy().and.callFake(async()=>{
      const first=!consumed;consumed=true;
      h.messages.set([message({payload:{type:'view-once-opened',at:openedAt,deviceId:'phone',deletedByUserId:'owner'}})]);
      return first?{openedAt,userId:'owner',deviceId:'phone'}:null;
    });
    await h.page.openViewOnce(h.item);
    expect(h.page.activeViewOnceTextMessage).toBe(h.item);
    h.page.reconcileMessageViewers(h.messages());expect(h.page.activeViewOnceTextMessage).toBe(h.item);
    await h.page.closeViewOnceText();expect(h.page.activeViewOnceTextMessage).toBeNull();
    await h.page.openViewOnce(h.item);expect(h.page.activeViewOnceTextMessage).toBeNull();
    expect(h.chat.markMessageOpened).not.toHaveBeenCalled();
  });
  it('closes a leased view on a different device receipt without mistaking its own echo for a second reader',async()=>{
    const h=harness(message({deleteAfterRead:true})),at=new Date().toISOString();
    (h.chat as any).claimViewOnceOpen=async()=>({openedAt:at,userId:'owner',deviceId:'phone'});
    await h.page.openViewOnce(h.item);
    h.messages.set([message({payload:{type:'view-once-opened',at,deviceId:'phone'},receipts:[{userId:'owner',deviceId:'other-phone',deletedAt:at}]})]);
    h.page.reconcileMessageViewers(h.messages());expect(h.page.activeViewOnceTextMessage).toBeNull();
  });
});

describe('Exact TTL cleanup includes single-view media', () => {
  it('removes a single-view message and revokes its cached preview at expiry instead of waiting for the 30-second sweep', fakeAsync(() => {
    const item = message({ deleteAfterRead: true, expiresAt: new Date(Date.now() + 1000).toISOString(), payload: { type: 'file', fileId: 'secret-file' } });
    const state = signal({ 'shared-chat': [item] });
    const service: any = Object.assign(Object.create(ChatService.prototype), {
      messagesByConversation: state, expiryTimers: new Map(),
      releaseMediaPreview: jasmine.createSpy('release'), forgetHistoryMessage: jasmine.createSpy('forget'), removeLocalMessage: jasmine.createSpy('remove'),
    });
    service.scheduleMessageExpiry(item); tick(999);
    expect(state()['shared-chat'].length).toBe(1); tick(1);
    expect(state()['shared-chat']).toEqual([]);
    expect(service.releaseMediaPreview).toHaveBeenCalledWith('secret-file');
    expect(service.removeLocalMessage).toHaveBeenCalledWith('shared-chat', item.id);
  }));
});
