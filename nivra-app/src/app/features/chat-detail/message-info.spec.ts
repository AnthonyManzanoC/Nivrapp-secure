import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { ChatMessageVm, Participant } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { TranslateService } from '../../core/services/translate.service';
import { earliestReceiptTime } from '../../core/utils/receipt-time';
import { ChatDetailPage } from './chat-detail.page';
import { MessageInfoContentComponent } from './message-info-content.component';
import { recipientReceipts } from './message-receipts';

const person = (userId: string, extra: Partial<Participant> = {}): Participant => ({userId,displayName:userId,role:'member',canInvite:false,canChangePrivacy:false,joinedAt:'2026-10-01T00:00:00Z',...extra});
const message = (extra: Partial<ChatMessageVm> = {}): ChatMessageVm => ({id:'message',clientMessageId:'client-message',conversationId:'chat',senderUserId:'me',mine:true,at:'2026-10-30T12:00:00Z',payload:{type:'text',text:'Private content'},...extra});
const delivered='2026-10-30T12:01:00Z', read='2026-10-30T12:02:00Z', later='2026-10-30T12:05:00Z';

describe('Message information and receipt evidence',()=>{
  it('groups multiple devices into one person and keeps first delivery and read evidence',()=>{
    const rows=recipientReceipts(message({receipts:[{userId:'a',deviceId:'phone',deliveredAt:delivered,readAt:read},{userId:'a',deviceId:'laptop',deliveredAt:later,readAt:later}]}),'me',[person('a'),person('me')]);
    expect(rows).toEqual([{userId:'a',deliveredAt:delivered,readAt:read,state:'read'}]);
  });
  it('lists recipients without confirmations as pending and never infers reading from delivery or deletion',()=>{
    const rows=recipientReceipts(message({receipts:[{userId:'a',deviceId:'phone',deliveredAt:delivered},{userId:'b',deviceId:'phone',deletedAt:read}]}),'me',[person('a'),person('b'),person('c')]);
    expect(rows.map(row=>row.state)).toEqual(['delivered','pending','pending']);
    expect(rows.every(row=>row.readAt===null)).toBeTrue();
  });
  it('excludes members who joined later but retains actual historical recipients',()=>{
    const rows=recipientReceipts(message({receipts:[{userId:'former',deviceId:'phone',readAt:read}]}),'me',[person('a'),person('later',{joinedAt:'2026-10-31T00:00:00Z'}),person('gone',{removedAt:'2026-10-20T00:00:00Z'})]);
    expect(rows.map(row=>row.userId)).toEqual(['a','former']);
  });
  it('ignores invalid timestamps and own-device receipts',()=>{
    const rows=recipientReceipts(message({receipts:[{userId:'me',deviceId:'other',readAt:read},{userId:'a',deviceId:'phone',readAt:'invalid',deliveredAt:delivered}]}),'me',[person('a')]);
    expect(rows).toEqual([{userId:'a',deliveredAt:delivered,readAt:null,state:'delivered'}]);
    expect(earliestReceiptTime('invalid',undefined)).toBeNull();
  });
  it('does not expose another account or received-message details',()=>{
    expect(recipientReceipts(message(),'other',[person('a')])).toEqual([]);
    expect(recipientReceipts(message({mine:false}),'me',[person('a')])).toEqual([]);
  });
  it('merges repeated and delayed realtime receipts monotonically without mutating the original',()=>{
    const service=Object.create(ChatService.prototype) as any;
    const original=[{userId:'a',deviceId:'phone',deliveredAt:delivered,readAt:read}];
    const duplicate=service.mergeReceipt(original,'a','phone','read',later);
    expect(duplicate[0].readAt).toBe(read);expect(duplicate[0].deliveredAt).toBe(delivered);
    const earlier='2026-10-30T12:00:30Z';
    const delayed=service.mergeReceipt(duplicate,'a','phone','delivered',earlier);
    expect(delayed[0].deliveredAt).toBe(earlier);expect(delayed[0].readAt).toBe(read);
    expect(original[0].deliveredAt).toBe(delivered);
  });
  it('reads the live message instead of the snapshot used to open information',()=>{
    const original=message(), updated=message({receipts:[{userId:'a',deviceId:'phone',readAt:read}]});
    const page=Object.assign(Object.create(ChatDetailPage.prototype),{messageInfoMessage:original,auth:{session:()=>({user:{id:'me'}})},conversation:()=>({id:'chat'}),messages:()=>[updated],privateChats:{isLocked:()=>false}}) as ChatDetailPage;
    expect(page.messageInfoCurrent()).toBe(updated);
    Object.assign(page,{messages:()=>[message({...updated,id:'server-message'})]});
    expect(page.messageInfoCurrent()?.id).toBe('server-message');
  });
  it('keeps realtime read evidence when an older HTTP receipt response arrives',()=>{
    const state=signal({chat:[message({receipts:[{userId:'a',deviceId:'phone',readAt:read}]})]});
    const service=Object.assign(Object.create(ChatService.prototype),{messagesByConversation:state,persistExistingMessage:()=>undefined}) as any;
    service.mergeMessageReceipts('message',[{userId:'a',deviceId:'phone',deliveredAt:delivered}]);
    expect(state().chat[0].receipts?.[0].readAt).toBe(read);
    expect(state().chat[0].receipts?.[0].deliveredAt).toBe(delivered);
  });
  it('keeps realtime read evidence when an older synchronized envelope is replayed',()=>{
    const state=signal({chat:[message({receipts:[{userId:'a',deviceId:'phone',readAt:read}]})]});
    const service=Object.assign(Object.create(ChatService.prototype),{messagesByConversation:state,pendingHistoryEnvelopes:new Map(),applyPendingReactions:(value:ChatMessageVm)=>value,persistLocalMessage:()=>undefined,touchConversationFromMessage:()=>undefined,scheduleMessageExpiry:()=>undefined}) as any;
    service.upsertMessage(message({receipts:[{userId:'a',deviceId:'phone',deliveredAt:delivered}]}));
    expect(state().chat[0].receipts?.[0].readAt).toBe(read);
  });
  it('hides message information after locking, account changes, removal or conversation changes',()=>{
    const current=message();let locked=false,owner='me',chat='chat',items=[current];
    const page=Object.assign(Object.create(ChatDetailPage.prototype),{messageInfoMessage:current,auth:{session:()=>({user:{id:owner}})},conversation:()=>({id:chat}),messages:()=>items,privateChats:{isLocked:()=>locked}}) as ChatDetailPage;
    expect(page.messageInfoCurrent()).toBe(current);
    locked=true;expect(page.messageInfoCurrent()).toBeNull();locked=false;
    owner='other';expect(page.messageInfoCurrent()).toBeNull();owner='me';
    chat='another';expect(page.messageInfoCurrent()).toBeNull();chat='chat';
    items=[];expect(page.messageInfoCurrent()).toBeNull();
  });
});

describe('Message information presentation',()=>{
  it('updates person counts and sections live and removes all details when the account changes',async()=>{
    const session=signal({user:{id:'me'}});
    const names:Record<string,string>={a:'Ana Torres',b:'Diego Luna',c:'Lucía Gómez'};
    TestBed.configureTestingModule({imports:[MessageInfoContentComponent],providers:[provideIonicAngular({mode:'ios'}),
      {provide:AuthService,useValue:{session}},{provide:ChatService,useValue:{participantDisplayName:(id:string)=>names[id],participantPhoto:()=>''}},
      {provide:TranslateService,useValue:{currentLanguage:signal('es'),instant:(_key:string,fallback:string)=>fallback}},
    ]});
    const init=TestBed.inject(ApplicationInitStatus) as unknown as {runInitializers():void;donePromise:Promise<void>};init.runInitializers();await init.donePromise;
    const fixture=TestBed.createComponent(MessageInfoContentComponent),view=fixture.componentInstance;
    const group=message({receipts:[{userId:'a',deviceId:'phone',readAt:read,deliveredAt:delivered},{userId:'b',deviceId:'phone',deliveredAt:delivered},{userId:'c',deviceId:'phone'}]});
    fixture.componentRef.setInput('message',group);fixture.componentRef.setInput('participants',[person('a'),person('b'),person('c')]);fixture.detectChanges();
    expect(view.readCount()).toBe(1);expect(view.deliveredCount()).toBe(2);expect(view.rows().length).toBe(3);
    expect(fixture.nativeElement.querySelectorAll('.receipt-group').length).toBe(3);
    fixture.componentRef.setInput('message',{...group,receipts:[...group.receipts!,{userId:'c',deviceId:'laptop',readAt:later}]});fixture.detectChanges();
    expect(view.readCount()).toBe(2);expect(view.deliveredCount()).toBe(3);expect(view.rows().length).toBe(3);
    session.set({user:{id:'other'}});fixture.detectChanges();expect(view.rows()).toEqual([]);
    expect(fixture.nativeElement.textContent).not.toContain(names['a']);
    if((window as any).__karma__?.config?.args?.includes('visual-message-info')){
      session.set({user:{id:'me'}});const root=fixture.nativeElement as HTMLElement;root.style.cssText='display:block;max-width:520px;margin:30px auto;border:1px solid var(--nivra-line);border-radius:24px;overflow:hidden';document.body.append(root);
      (window as any).__messageInfoVisual=(direct:boolean)=>{fixture.componentRef.setInput('message',direct?{...group,receipts:[group.receipts![0]]}:group);fixture.componentRef.setInput('participants',direct?[person('a')]:[person('a'),person('b'),person('c')]);fixture.detectChanges();};
      await new Promise<void>(resolve=>(window as any).__messageInfoVisualDone=resolve);root.remove();
    }
    fixture.destroy();
  },180000);
});
