import { signal } from '@angular/core';
import { of, Subject, throwError } from 'rxjs';
import { AccountHistoryUnsupportedMessage } from '../utils/account-history-sync';
import { AccountHistorySyncService } from './account-history-sync.service';
import { HistoryArchiveService } from './history-archive.service';

describe('automatic account history recovery boundaries',()=>{
  let service:any,session:any,generation:any,lockCycle:any,history:any,identity:any,archive:any,api:any;
  const message:any={id:'msg_history',clientMessageId:'client_history',conversationId:'con_history',senderUserId:'alice',senderDeviceId:'apk1',at:'2026-11-15T10:00:00.000Z',mine:true,payload:{type:'text',text:'Privado'}};
  beforeEach(()=>{
    session=signal({user:{id:'alice'},device:{id:'web'}});generation=signal(1);lockCycle=signal(0);
    history={readRatchetState:jasmine.createSpy().and.resolveTo(null),commitRatchetState:jasmine.createSpy().and.resolveTo(1),accountKeysForUser:async()=>[],conversations:jasmine.createSpy().and.resolveTo([]),conversationMessagesPage:jasmine.createSpy().and.resolveTo([])};
    identity={historyRoot:async()=>'root',openHistory:jasmine.createSpy().and.resolveTo(message),sealHistory:jasmine.createSpy().and.resolveTo({messageId:message.id})};
    archive={importMessages:jasmine.createSpy().and.resolveTo()};
    api={get:jasmine.createSpy().and.returnValue(of({messages:[{messageId:message.id}],next:'9007199254740993',hasMore:false})),post:jasmine.createSpy().and.returnValue(of({accepted:[message.id]}))};
    service=Object.assign(Object.create(AccountHistorySyncService.prototype),{auth:{session,sessionGeneration:generation},lock:{isContentLocked:()=>false,lockCycle},identity,archive,history,api,network:{readTimeoutMs:()=>30_000},
      running:null,scope:'alice-web',scans:[],scanPrepared:true,scanAt:Date.now(),queued:new Map(),uploaded:new Set(),retryAt:0,nextRestoreAt:0,restoreComplete:false,state:signal('idle')});
  });
  it('commits a lossless cursor only after verified decryption and authoritative guarded hydration',async()=>{
    const order:string[]=[];
    identity.openHistory.and.callFake(async()=>{order.push('decrypt');return message;});archive.importMessages.and.callFake(async()=>order.push('import'));
    history.commitRatchetState.and.callFake(async()=>{order.push('checkpoint');return 1;});
    expect(await service.restore('root')).toBeTrue();expect(order).toEqual(['decrypt','import','checkpoint']);
    expect(history.commitRatchetState.calls.mostRecent().args).toEqual(['alice','account-history-sync:web',0,{v:1,root:'root',cursor:'9007199254740993'}]);
  });
  it('never hydrates or advances past a failed signature/decryption',async()=>{
    identity.openHistory.and.rejectWith(Error('invalid signature'));
    await expectAsync(service.restore('root')).toBeRejected();expect(archive.importMessages).not.toHaveBeenCalled();expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('does not hydrate a page that arrives after the synchronization service is destroyed',async()=>{
    const page=new Subject<any>();api.get.and.returnValue(page);
    const operation=service.restore('root');await Promise.resolve();
    service.destroyed=true;page.next({messages:[{messageId:message.id}],next:'1',hasMore:false});page.complete();
    await expectAsync(operation).toBeRejected();
    expect(archive.importMessages).not.toHaveBeenCalled();expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('discards a delayed page after account or generation changes',async()=>{
    const page=new Subject<any>();api.get.and.returnValue(page);
    const pending=service.restore('root');await Promise.resolve();await Promise.resolve();
    generation.set(2);session.set({user:{id:'bob'},device:{id:'bob-phone'}});
    page.next({messages:[{messageId:message.id}],next:'1',hasMore:false});page.complete();
    await expectAsync(pending).toBeRejected();expect(identity.openHistory).not.toHaveBeenCalled();expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('discards a delayed page even if Safe Mode was already unlocked again',async()=>{
    const page=new Subject<any>();api.get.and.returnValue(page);
    const pending=service.restore('root');await Promise.resolve();
    lockCycle.set(2);
    page.next({messages:[{messageId:message.id}],next:'1',hasMore:false});page.complete();
    await expectAsync(pending).toBeRejected();
    expect(identity.openHistory).not.toHaveBeenCalled();
    expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('keeps synchronizing when its bounded three-page turn still has more history',async()=>{
    let next=0;api.get.and.callFake(()=>of({messages:[],next:String(++next),hasMore:true}));
    expect(await service.restore('root')).toBeFalse();expect(api.get).toHaveBeenCalledTimes(3);expect(history.commitRatchetState.calls.mostRecent().args[3].cursor).toBe('3');
  });
  it('retains the exact queued message across a failed archive upload',async()=>{
    service.queued.set(message.id,message);api.post.and.returnValue(throwError(()=>({status:503})));
    await expectAsync(service.capture()).toBeRejected();expect(service.queued.get(message.id)).toBe(message);expect(service.uploaded.size).toBe(0);
    api.post.and.returnValue(of({accepted:[message.id]}));await service.capture();expect(service.queued.size).toBe(0);expect(service.uploaded.has(message.id)).toBeTrue();
  });
  it('retries transient local encryption errors without losing scanned messages',async()=>{
    service.queued.set(message.id,message);
    identity.sealHistory.and.rejectWith(Error('storage unavailable'));
    await expectAsync(service.capture()).toBeRejected();
    expect(service.queued.get(message.id)).toBe(message);
    expect(api.post).not.toHaveBeenCalled();
    identity.sealHistory.and.resolveTo({messageId:message.id});
    await service.capture();
    expect(service.uploaded.has(message.id)).toBeTrue();
  });
  it('archives the rest of a batch when a single row cannot be copied',async()=>{
    const unsupported={...message,id:'oversized'};
    service.queued.set(unsupported.id,unsupported);service.queued.set(message.id,message);
    identity.sealHistory.and.callFake(async (candidate:any)=>{
      if(candidate.id===unsupported.id)throw new AccountHistoryUnsupportedMessage('oversized');
      return {messageId:candidate.id};
    });
    await service.capture();
    expect(api.post.calls.mostRecent().args[1].messages).toEqual([{messageId:message.id}]);
    expect(service.queued.size).toBe(0);
    expect(service.uploaded.has(message.id)).toBeTrue();
  });
  it('keeps bounded deduplication and does not treat unsupported old APIs as recovered history',async()=>{
    for(let index=0;index<10001;index++)service.remember('msg_'+index);expect(service.uploaded.size).toBe(10000);
    api.get.and.returnValue(throwError(()=>({status:404})));await service.pump();
    expect(service.state()).toBe('unavailable');expect(archive.importMessages).not.toHaveBeenCalled();expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('polls a settled account at most once a minute and waits a minute after rate limiting',async()=>{
    let now=Date.now();spyOn(Date,'now').and.callFake(()=>now);
    api.get.and.returnValue(of({messages:[],next:'0',hasMore:false}));
    await service.pump();expect(service.state()).toBe('ready');
    now+=59_999;await service.pump();expect(api.get).toHaveBeenCalledTimes(1);
    now++;api.get.and.returnValue(throwError(()=>({status:429})));
    await service.pump();expect(service.state()).toBe('unavailable');
    now+=59_999;await service.pump();expect(api.get).toHaveBeenCalledTimes(2);
    now++;api.get.and.returnValue(of({messages:[],next:'0',hasMore:false}));
    await service.pump();expect(api.get).toHaveBeenCalledTimes(3);expect(service.state()).toBe('ready');
  });
  it('allows a new account to finish synchronization before the previous account request returns',async()=>{
    const previous=new Subject<any>();
    api.get.and.returnValues(previous,of({messages:[],next:'0',hasMore:false}));
    const started=service.pump();
    for(let turn=0;turn<30&&!api.get.calls.any();turn++)await new Promise(done=>setTimeout(done,5));
    expect(api.get).toHaveBeenCalledTimes(1);
    generation.set(2);session.set({user:{id:'bob'},device:{id:'bob-phone'}});
    await service.pump();expect(api.get).toHaveBeenCalledTimes(2);expect(service.state()).toBe('ready');
    previous.next({messages:[{messageId:message.id}],next:'1',hasMore:false});previous.complete();
    await started;expect(service.state()).toBe('ready');expect(identity.openHistory).not.toHaveBeenCalled();
  });
  it('only scans missing pairs when refreshing a catalogue of completed chats',async()=>{
    service.scans=[{account:'alice',conversation:'old',complete:true}];
    service.scanAt=Date.now()-301_000;
    history.conversations.and.resolveTo([{id:'old'},{id:'new'}]);
    await service.capture();
    expect(history.conversationMessagesPage.calls.allArgs().map((args:any[])=>args[1])).toEqual(['new','ratchet-receipt:new']);
    expect(service.scans.every((scan:any)=>scan.complete)).toBeTrue();
  });
  it('rejects malformed or nonadvancing cursors before unsealing a message',async()=>{
    for(const next of ['0','-1','00','9223372036854775808','9'.repeat(10000)]){
      api.get.and.returnValue(of({messages:[{messageId:message.id}],next,hasMore:false}));
      await expectAsync(service.restore('root')).toBeRejected();
    }
    expect(identity.openHistory).not.toHaveBeenCalled();
    expect(history.commitRatchetState).not.toHaveBeenCalled();
  });
  it('does not archive pending or scheduled local drafts before server acceptance',()=>{
    expect(service.normalized({...message,status:'sending'})).toBeNull();
    expect(service.normalized({...message,id:'local-unpublished'})).toBeNull();
    expect(service.normalized({...message,payload:{...message.payload,__nivraOutbox:'local queue ownership'}})).toBeNull();
    expect(service.normalized({...message,status:'sent'})).toEqual({...message,status:'sent'});
  });
});

describe('root archive shares the guarded history importer',()=>{
  const candidate:any={id:'msg_history',clientMessageId:'client_history',conversationId:'con_history',senderUserId:'alice',senderDeviceId:'apk1',at:'2026-11-15T10:00:00.000Z',mine:true,payload:{type:'text',text:'Privado'}};
  it('cannot restore a server-deleted message or cross a local deletion fence',async()=>{
    const merge=jasmine.createSpy().and.resolveTo(),guard=jasmine.createSpy().and.returnValue(false);
    const history={messageWriteGuard:()=>guard,mergeArchiveMessages:merge,messageById:async()=>candidate};
    const api={post:jasmine.createSpy().and.returnValue(of({messages:[],deletedMessages:[{messageId:candidate.id}]}))};
    const service:any=Object.assign(Object.create(HistoryArchiveService.prototype),{auth:{session:()=>({user:{id:'alice'},device:{id:'web'}}),sessionGeneration:()=>1},lock:{isContentLocked:()=>false},history,api,imported$:new Subject<void>()});
    await service.importMessages([candidate]);expect(merge).not.toHaveBeenCalled();
    api.post.and.returnValue(of({messages:[{id:candidate.id,clientMessageId:candidate.clientMessageId,conversationId:candidate.conversationId,senderUserId:'alice',senderDeviceId:'apk1',serverReceivedAt:candidate.at,deleteAfterRead:false,receipts:[]}],deletedMessages:[]}));
    await service.importMessages([candidate]);expect(guard).toHaveBeenCalled();expect(merge).not.toHaveBeenCalled();
  });
});
