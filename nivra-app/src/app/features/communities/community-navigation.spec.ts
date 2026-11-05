import { signal } from '@angular/core';
import { convertToParamMap } from '@angular/router';
import { CommunitiesPage } from './communities.page';
import { ChatDetailPage } from '../chat-detail/chat-detail.page';

describe('community information and chat return navigation',()=>{
  it('keeps information inside its community and preserves the Chats entry point',()=>{
    const page=Object.create(CommunitiesPage.prototype) as CommunitiesPage,navigate=jasmine.createSpy('navigate').and.resolveTo(true);
    Object.assign(page,{selectedId:signal('community-one'),infoOpen:signal(true),fromChats:signal(true),router:{navigate}});
    page.back();expect(navigate).toHaveBeenCalledOnceWith(['/app/communities'],{queryParams:{id:'community-one',from:'chats'}});
  });
  it('returns from announcements or a linked group to the originating community',async()=>{
    const page=Object.create(ChatDetailPage.prototype) as ChatDetailPage,navigate=jasmine.createSpy('navigate').and.resolveTo(true),navigateByUrl=jasmine.createSpy('navigateByUrl');
    Object.assign(page,{selectionMode:false,route:{snapshot:{queryParamMap:convertToParamMap({community:'community-one',communityFrom:'chats'})}},router:{navigate,navigateByUrl}});
    await page.back();expect(navigate).toHaveBeenCalledOnceWith(['/app/communities'],{queryParams:{id:'community-one',from:'chats'}});expect(navigateByUrl).not.toHaveBeenCalled();
  });
  it('opens dedicated community information instead of the group profile for its announcement conversation',()=>{
    const page=Object.create(ChatDetailPage.prototype) as ChatDetailPage,navigate=jasmine.createSpy('navigate').and.resolveTo(true);
    Object.assign(page,{conversation:()=>({id:'community-one'}),injector:{get:()=>({items:()=>[{id:'community-one'}]})},route:{snapshot:{queryParamMap:convertToParamMap({community:'community-one'})}},router:{navigate}});
    page.openContactInfo();expect(navigate).toHaveBeenCalledOnceWith(['/app/communities'],{queryParams:{id:'community-one',info:1}});
  });
});
