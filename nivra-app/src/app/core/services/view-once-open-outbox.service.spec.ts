import { signal } from '@angular/core';
import { Subject, of, throwError } from 'rxjs';
import { ViewOnceOpenOutboxService } from './view-once-open-outbox.service';
import { ChatService } from './chat.service';

describe('Durable one-view consumption and receipt recovery',()=>{
  const message:any={id:'msg_once',conversationId:'con_shared',senderUserId:'peer',mine:false,deleteAfterRead:true,at:'2026-11-16T00:00:00.000Z',payload:{type:'text',text:'Never persist this plaintext in the receipt queue'}};
  let rows:Map<string,any>,session:any,generation:any,locked:any,history:any,api:any,realtime:any;
  beforeEach(()=>{
    rows=new Map();session=signal<any>({user:{id:'owner'},device:{id:'phone'}});generation=signal(1);locked=signal(false);
    history={readRatchetState:jasmine.createSpy().and.callFake(async(user:string,key:string)=>structuredClone(rows.get(user+key)??null)),
      commitRatchetState:jasmine.createSpy().and.callFake(async(user:string,key:string,revision:number,state:any)=>{
        await Promise.resolve();const prior=rows.get(user+key);if((prior?.revision??0)!==revision)throw Object.assign(Error('CAS'),{retryable:true});
        rows.set(user+key,{revision:revision+1,state:structuredClone(state)});return revision+1;
      })};
    api={post:jasmine.createSpy().and.returnValue(of({id:message.id,receipts:[]}))};
    realtime={syncReadReceipts:jasmine.createSpy().and.resolveTo()};
    spyOnProperty(document,'visibilityState','get').and.returnValue('visible');
    spyOnProperty(navigator,'onLine','get').and.returnValue(true);
  });
  function create():any{return Object.assign(Object.create(ViewOnceOpenOutboxService.prototype),{auth:{session,sessionGeneration:generation},lock:{isContentLocked:locked},history,api,realtime,
    serial:Promise.resolve(),running:false,destroyed:false,retryAt:0,acknowledged$:new Subject()});}
  it('persists only consumption metadata before returning the first grant and never grants it twice after a restart',async()=>{
    const first=create();expect((await first.claim(message)).first).toBeTrue();
    expect(JSON.stringify([...rows.values()])).not.toContain(message.payload.text);
    const restarted=create();expect((await restarted.claim(message)).first).toBeFalse();
    expect((await restarted.consumed(message.id,message.conversationId)).openedAt).toBeTruthy();
  });
  it('serializes competing windows through CAS so only one can expose the original',async()=>{
    const results=await Promise.all([create().claim(message),create().claim(message)]);
    expect(results.filter(row=>row.first).length).toBe(1);expect(rows.size).toBe(1);
  });
  it('retains consumed state through offline receipt failure, then repairs the receipt after restart',async()=>{
    const first=create();await first.claim(message);api.post.and.returnValue(throwError(()=>({status:0})));
    await first.flush();expect((await first.claim(message)).first).toBeFalse();
    const restarted=create();api.post.and.returnValue(of({id:message.id,receipts:[]}));await restarted.flush();
    expect(api.post.calls.mostRecent().args).toEqual(['/messages/msg_once/receipt',{kind:'Read',opened:true}]);
    expect((await restarted.consumed(message.id,message.conversationId)).completed).toBeTrue();
    await restarted.flush();expect(api.post).toHaveBeenCalledTimes(2);
    expect((await restarted.claim(message)).first).toBeFalse();
  });
  it('never grants opening when durable storage fails or locks during the write',async()=>{
    history.commitRatchetState.and.rejectWith(Error('Storage unavailable'));await expectAsync(create().claim(message)).toBeRejected();
    expect(api.post).not.toHaveBeenCalled();
    history.commitRatchetState.and.callFake(async()=>{locked.set(true);return 1;});
    await expectAsync(create().claim(message)).toBeRejected();
  });
  it('does not acknowledge or synchronize an old account after its delayed receipt arrives',async()=>{
    const service=create();await service.claim(message);const pending=new Subject<any>();api.post.and.returnValue(pending);
    const flushing=service.flush();for(let n=0;n<5;n++)await Promise.resolve();
    session.set({user:{id:'other'},device:{id:'other-device'}});generation.set(2);
    pending.next({id:message.id});pending.complete();await flushing;
    expect(realtime.syncReadReceipts).not.toHaveBeenCalled();
    session.set({user:{id:'owner'},device:{id:'phone'}});generation.set(3);
    expect((await service.consumed(message.id,message.conversationId)).completed).toBeFalse();
  });
  it('rejects a forged cross-account snapshot and never sends its IDs',async()=>{
    rows.set('ownerview-once-open-v1:phone',{revision:1,state:{v:1,userId:'someone-else',deviceId:'phone',records:{}}});
    await expectAsync(create().claim(message)).toBeRejected();await create().flush();expect(api.post).not.toHaveBeenCalled();
  });
  it('rejects prototype-like IDs and expired content instead of granting a synthetic consumption record',async()=>{
    for(const id of ['__proto__','constructor','prototype'])await expectAsync(create().claim({...message,id})).toBeRejected();
    await expectAsync(create().claim({...message,expiresAt:'invalid'})).toBeRejected();
    await expectAsync(create().claim({...message,expiresAt:new Date(0).toISOString()})).toBeRejected();
    expect(rows.size).toBe(0);expect(api.post).not.toHaveBeenCalled();
  });
  it('does not resurrect consumed content from a stale encrypted local history page',async()=>{
    const once=create();await once.claim(message);
    const service:any=Object.assign(Object.create(ChatService.prototype),{onceOpens:once,auth:{session,sessionGeneration:generation},privateChats:{isLocked:()=>false},
      history:{...history,putMessages:jasmine.createSpy().and.resolveTo(),removeMessage:async()=>{}},readReceiptSentIds:new Set(),
      messagesByConversation:signal({con_shared:[message]}),releaseMediaPreview:()=>{},localAccountKey:()=> 'owner',persistLocalMessage:()=>{}});
    expect(await service.claimViewOnceOpen(message)).toBeNull();
    expect(service.messagesByConversation().con_shared[0].payload.type).toBe('view-once-opened');
    expect(service.messagesByConversation().con_shared[0].payload.text).not.toBe(message.payload.text);
  });
});
