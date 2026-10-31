import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { ChatMessageVm } from '../../core/models/nivra.models';
import { ChatService } from '../../core/services/chat.service';
import { ChatDetailPage } from './chat-detail.page';

const message=(id:string,extra:Partial<ChatMessageVm>={}):ChatMessageVm=>({id,conversationId:'chat',senderUserId:'me',mine:true,at:'2026-10-30T12:00:00Z',payload:{type:'text',text:id},...extra});
function fixture(){
  let owner='me',locked=false,items=[message('one'),message('two'),message('three')];
  const remove=jasmine.createSpy('delete').and.callFake(async(value:ChatMessageVm)=>{items=items.filter(item=>item.id!==value.id);});
  const forward=jasmine.createSpy('forward').and.resolveTo(1);
  const page=Object.assign(Object.create(ChatDetailPage.prototype),{
    auth:{session:()=>({user:{id:owner},device:{id:'phone'}}),sessionGeneration:()=>1},
    conversation:()=>({id:'chat'}),messages:()=>items,privateChats:{isLocked:()=>locked},
    chat:{deleteMessage:remove,forwardMessageToConversations:forward,forwardAvailability:(value:ChatMessageVm)=>({ok:!value.deleteAfterRead&&!value.decryptError&&value.payload.forwardingAllowed!==false})},
    selectedMessageIds:signal(new Set<string>()),selectedForwardIds:new Set<string>(),forwardingSelectionIds:[],forwardingCompleted:new Set<string>(),
    selectionEpoch:0,selectionScope:null,selectionMode:false,selectionError:'',bulkBusy:false,busyAction:'',
    composerGeneration:1,destroyed:false,sending:false,recordingVoice:false,voiceStarting:false,forwardingMessage:null,
    closeChatMenu:()=>undefined,closeMessageActions:()=>undefined,closeSearch:()=>undefined,
    tr:(_key:string,fallback:string)=>fallback,
  }) as ChatDetailPage;
  return {page,remove,forward,items:()=>items,setItems:(value:ChatMessageVm[])=>items=value,setOwner:(value:string)=>owner=value,setLocked:(value:boolean)=>locked=value};
}
describe('Multi-message selection',()=>{
  beforeEach(()=>{spyOn(window,'confirm').and.returnValue(true);});
  it('selects and deselects several messages while keeping a bounded selection',()=>{
    const h=fixture();h.page.beginSelection(h.items()[0]);h.page.toggleMessageSelection(h.items()[1]);
    expect(h.page.selectedMessages().map(item=>item.id)).toEqual(['one','two']);
    h.page.toggleMessageSelection(h.items()[0]);expect(h.page.selectedMessages().map(item=>item.id)).toEqual(['two']);
    const many=Array.from({length:101},(_,i)=>message('m'+i));h.setItems(many);h.page.beginSelection();many.forEach(item=>h.page.toggleMessageSelection(item));
    expect(h.page.selectedMessages().length).toBe(100);expect(h.page.selectionError).toContain('100');
  });
  it('confirms once for the batch and deletes only selected messages',async()=>{
    const h=fixture();h.page.beginSelection(h.items()[0]);h.page.toggleMessageSelection(h.items()[1]);await h.page.deleteSelection(false);
    expect(window.confirm).toHaveBeenCalledTimes(1);expect(h.remove.calls.allArgs().map(args=>args[0].id)).toEqual(['one','two']);
    expect(h.remove.calls.allArgs().every(args=>args[1]===false)).toBeTrue();expect(h.items().map(item=>item.id)).toEqual(['three']);expect(h.page.selectionMode).toBeFalse();
  });
  it('never offers deleting received messages for everyone',async()=>{
    const h=fixture();h.setItems([message('one'),message('received',{mine:false,senderUserId:'other'})]);h.page.beginSelection(h.items()[0]);h.page.toggleMessageSelection(h.items()[1]);
    expect(h.page.canDeleteSelectionForEveryone()).toBeFalse();await h.page.deleteSelection(true);expect(h.remove).not.toHaveBeenCalled();expect(window.confirm).not.toHaveBeenCalled();
  });
  it('keeps only unfinished deletions selected after a partial failure',async()=>{
    const h=fixture();h.page.beginSelection();h.items().forEach(item=>h.page.toggleMessageSelection(item));let failed=false;
    h.remove.and.callFake(async(value:ChatMessageVm)=>{if(value.id==='two'&&!failed){failed=true;throw Error('offline');}h.setItems(h.items().filter(item=>item.id!==value.id));});
    await h.page.deleteSelection(false);expect(h.page.selectedMessages().map(item=>item.id)).toEqual(['two','three']);expect(h.page.selectionError).toBe('offline');
    await h.page.deleteSelection(false);expect(h.remove.calls.allArgs().map(args=>args[0].id)).toEqual(['one','two','two','three']);expect(h.page.selectionMode).toBeFalse();
  });
  it('stops before another deletion after the account changes',async()=>{
    const h=fixture();h.page.beginSelection();h.items().forEach(item=>h.page.toggleMessageSelection(item));h.remove.and.callFake(async()=>{h.setOwner('other');});
    await h.page.deleteSelection(false);expect(h.remove).toHaveBeenCalledTimes(1);expect(h.page.selectedMessages()).toEqual([]);
  });
  it('stops before another deletion when the chat locks',async()=>{
    const h=fixture();h.page.beginSelection();h.items().forEach(item=>h.page.toggleMessageSelection(item));h.remove.and.callFake(async()=>{h.setLocked(true);});
    await h.page.deleteSelection(false);expect(h.remove).toHaveBeenCalledTimes(1);expect(h.page.selectedMessages()).toEqual([]);
  });
  it('does not run two deletion batches after repeated taps',async()=>{
    const h=fixture();h.page.beginSelection(h.items()[0]);let finish!:()=>void;h.remove.and.returnValue(new Promise<void>(resolve=>finish=resolve));
    const first=h.page.deleteSelection(false);await h.page.deleteSelection(false);expect(h.remove).toHaveBeenCalledTimes(1);finish();await first;
  });
  it('disallows forwarding the entire selection if a message is restricted',()=>{
    const h=fixture();h.setItems([message('once',{deleteAfterRead:true}),message('normal')]);h.page.beginSelection(h.items()[0]);h.page.toggleMessageSelection(h.items()[1]);
    expect(h.page.canForwardSelection()).toBeFalse();h.page.openSelectionForward();expect(h.page.forwardingMessage).toBeNull();expect(h.forward).not.toHaveBeenCalled();
  });
  it('forwards selected messages in their original order',async()=>{
    const h=fixture();h.page.beginSelection(h.items()[1]);h.page.toggleMessageSelection(h.items()[0]);h.page.openSelectionForward();h.page.selectedForwardIds.add('destination');
    await h.page.sendForward();expect(h.forward.calls.allArgs().map(args=>args[0].id)).toEqual(['one','two']);expect(h.forward.calls.allArgs().every(args=>args[1][0]==='destination')).toBeTrue();expect(h.page.selectionMode).toBeFalse();
  });
  it('skips acknowledged forwards when retrying a partial batch',async()=>{
    const h=fixture();h.page.beginSelection(h.items()[0]);h.page.openSelectionForward();h.page.selectedForwardIds.add('a');h.page.selectedForwardIds.add('b');h.forward.and.returnValues(Promise.resolve(1),Promise.resolve(0),Promise.resolve(1));
    await h.page.sendForward();expect(h.page.selectionError).toBeTruthy();expect(h.page.selectionMode).toBeTrue();await h.page.sendForward();
    expect(h.forward.calls.allArgs().map(args=>args[1][0])).toEqual(['a','b','b']);expect(h.page.selectionMode).toBeFalse();
  });
  it('cancels future forwards when the destination picker is closed',async()=>{
    const h=fixture();h.page.beginSelection(h.items()[0]);h.page.toggleMessageSelection(h.items()[1]);h.page.openSelectionForward();h.page.selectedForwardIds.add('a');
    let finish!:(value:number)=>void;h.forward.and.returnValue(new Promise<number>(resolve=>finish=resolve));const pending=h.page.sendForward();h.page.closeForward();finish(1);await pending;
    expect(h.forward).toHaveBeenCalledTimes(1);expect(h.page.bulkBusy).toBeFalse();expect(h.page.selectionMode).toBeTrue();
  });
  it('does not begin selection from another conversation or select an unsent message',()=>{
    const h=fixture();h.page.beginSelection(message('old',{conversationId:'other'}));expect(h.page.selectionMode).toBeFalse();
    h.page.beginSelection();h.page.toggleMessageSelection(message('sending',{status:'sending'}));expect(h.page.selectedMessages()).toEqual([]);
  });
  it('does not apply an old delete sheet to a new selection',async()=>{
    const h=fixture();let options:any;
    Object.assign(h.page,{actionSheetController:{create:async(value:unknown)=>{options=value;return {present:async()=>undefined};}}});
    h.page.beginSelection(h.items()[0]);await h.page.openSelectionDelete();h.page.cancelSelection();h.page.beginSelection(h.items()[1]);
    options.buttons[0].handler();await Promise.resolve();expect(h.remove).not.toHaveBeenCalled();
  });
});

describe('Message operation account boundaries',()=>{
  it('does not remove a new account’s copy when an old deletion response finishes',async()=>{
    let owner='me';const response=new Subject<unknown>();const apply=jasmine.createSpy('apply');
    const service=Object.assign(Object.create(ChatService.prototype),{auth:{session:()=>({user:{id:owner},device:{id:'phone'}})},privateChats:{isLocked:()=>false},api:{delete:()=>response},applyMessageDeleted:apply}) as ChatService;
    const pending=service.deleteMessage(message('one'),false);owner='other';response.next({});response.complete();await pending;expect(apply).not.toHaveBeenCalled();
  });
  it('rejects unavailable content before any forwarding begins',()=>{
    const service=Object.assign(Object.create(ChatService.prototype),{privateChats:{isLocked:()=>false}}) as ChatService;
    for(const value of [message('sending',{status:'sending'}),message('locked',{decryptError:true}),message('expired',{expiresAt:'2026-01-01T00:00:00Z'}),message('once',{deleteAfterRead:true})])expect(service.forwardAvailability(value).ok).toBeFalse();
  });
});
