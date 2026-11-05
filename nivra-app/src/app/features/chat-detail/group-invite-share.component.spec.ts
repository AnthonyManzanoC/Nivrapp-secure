import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { GroupInviteShareComponent } from './group-invite-share.component';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService } from '../../core/services/native-device.service';

describe('group and community invitation sharing',()=>{
  let instance:GroupInviteShareComponent,api:any,chat:any,native:any,session:any;
  beforeEach(()=>{
    session=signal({user:{id:'alice'},device:{id:'phone'}});
    api={post:jasmine.createSpy().and.returnValue(of({id:'invite',code:'a'.repeat(43)})),get:jasmine.createSpy().and.returnValue(of([])),delete:jasmine.createSpy().and.returnValue(of(null))};
    const conversation={id:'chat',title:'Bob',participants:[{userId:'bob'}]};
    chat={conversations:signal([conversation]),contacts:signal([{userId:'carol',alias:'carol',displayName:'Carol'}]),canSendToConversation:()=>true,isConversationBlocked:()=>false,isGroup:()=>false,conversationTitle:(c:any)=>c.title,conversationPhoto:()=>'',sendText:jasmine.createSpy().and.resolveTo(undefined),createDirectConversation:jasmine.createSpy().and.resolveTo({id:'carol-chat'})};
    native={copyToClipboard:jasmine.createSpy().and.resolveTo(undefined),shareText:jasmine.createSpy().and.resolveTo('shared')};
    TestBed.configureTestingModule({providers:[{provide:NivraApiService,useValue:api},{provide:ChatService,useValue:chat},{provide:AuthService,useValue:{session,sessionGeneration:signal(1)}},{provide:NativeDeviceService,useValue:native}]});
    instance=TestBed.runInInjectionContext(()=>new GroupInviteShareComponent());instance.conversationId='community';instance.community=true;instance.title='Casa';
  });
  it('creates one URL usable outside the app and sends it through selected existing chats and new contact chats',async()=>{
    await instance.create();expect(instance.validLink()).toBe('https://nivrapp-secure.vercel.app/group/invite#'+'a'.repeat(43));
    await instance.shareOutside();expect(native.shareText.calls.mostRecent().args[0]).toContain('la comunidad Casa');
    instance.toggle('chat:chat');instance.toggle('contact:carol');instance.query='Bob';await instance.send();
    expect(chat.sendText).toHaveBeenCalledTimes(2);expect(chat.createDirectConversation.calls.mostRecent().args[0].id).toBe('carol');expect(instance.selected.size).toBe(0);
  });
  it('does not expose a late invitation response after an account switch',async()=>{
    const response=new Subject<any>();api.post.and.returnValue(response);const pending=instance.create();session.set({user:{id:'other'},device:{id:'other-phone'}});response.next({id:'late',code:'b'.repeat(43)});response.complete();await pending;expect(instance.validLink()).toBe('');expect(instance.visibleLinks()).toEqual([]);
  });
  it('keeps only failed destinations selected for retry',async()=>{
    await instance.create();chat.sendText.and.callFake(async(c:any)=>{if(c.id==='carol-chat')throw Error('offline');});instance.toggle('chat:chat');instance.toggle('contact:carol');await instance.send();expect([...instance.selected]).toEqual(['contact:carol']);
  });
  it('invalidates an in-flight response when the selected community changes',async()=>{
    const response=new Subject<any>();api.post.and.returnValue(response);const pending=instance.create();instance.conversationId='another';instance.ngOnChanges();response.next({id:'late',code:'b'.repeat(43)});response.complete();await pending;expect(instance.validLink()).toBe('');
  });
});
