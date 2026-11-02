import { fakeAsync, tick } from '@angular/core/testing';
import { ChatDetailPage } from './chat-detail.page';

describe('opening a conversation at its newest messages',()=>{
  function page(){
    const instance=Object.create(ChatDetailPage.prototype) as any;
    Object.assign(instance,{destroyed:false,initialScrollTimers:[],initialScrollDoneForConversation:'',conversation:()=>({id:'current'}),chat:{initialScrollMessageId:()=> 'first-unread'},content:{scrollToBottom:jasmine.createSpy().and.resolveTo()}});
    return instance;
  }
  it('opens at the bottom while preserving the unread divider for reading older messages',fakeAsync(()=>{
    const p=page();p.scheduleInitialScroll('current');tick(1000);
    expect(p.content.scrollToBottom).toHaveBeenCalledWith(0);expect(p.initialUnreadMessageId).toBe('first-unread');expect(p.openingLatest).toBeFalse();
  }));
  it('stops repositioning immediately when the user starts reading older messages',fakeAsync(()=>{
    const p=page();p.scheduleInitialScroll('current');tick(0);const count=p.content.scrollToBottom.calls.count();
    p.stopInitialScroll();tick(1500);expect(p.content.scrollToBottom.calls.count()).toBe(count);expect(p.openingLatest).toBeFalse();
  }));
  it('does not scroll another conversation after a late render callback',fakeAsync(()=>{
    const p=page();p.scheduleInitialScroll('old');tick(1500);expect(p.content.scrollToBottom).not.toHaveBeenCalled();
  }));
  it('does not paginate older messages while positioning the initial view',async()=>{
    const p=page();p.openingLatest=true;p.chat.loadOlderMessages=jasmine.createSpy();
    const complete=jasmine.createSpy().and.resolveTo();await p.loadOlderMessages({target:{complete}});
    expect(p.chat.loadOlderMessages).not.toHaveBeenCalled();expect(complete).toHaveBeenCalled();
  });
});
