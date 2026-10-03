import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { GroupHubComponent } from './group-hub.component';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';

describe('group hub', () => {
  function create() {
    const groups = signal([
      {id:'team', type:'Group',title:'Equipo',settings:{sendMessages:'all'},participants:[{userId:'me'}]},
      {id:'news', type:'Group',title:'Avisos',settings:{sendMessages:'admins'},participants:[{userId:'me'}]},
      {id:'removed', type:'Group',title:'Anterior',participants:[{userId:'me',removedAt:'2026-01-01'}]},
      {id:'direct', type:'Direct',title:'Contacto',participants:[{userId:'me'}]},
    ]);
    TestBed.configureTestingModule({providers:[
      {provide:ChatService,useValue:{conversations:groups,isGroup:(g:{type:string})=>g.type==='Group',conversationTitle:(g:{title:string})=>g.title}},
      {provide:AuthService,useValue:{session:()=>({user:{id:'me'}})}},
    ]});
    return TestBed.runInInjectionContext(()=>new GroupHubComponent());
  }
  it('shows only groups where the current account is still a member',()=>{
    expect(create().groups().map(g=>g.id)).toEqual(['team','news']);
  });
  it('combines search with actual administrator-only posting rules',()=>{
    const hub=create();hub.announcements.set(true);expect(hub.filtered().map(g=>g.id)).toEqual(['news']);
    hub.query.set(' equipo ');expect(hub.filtered()).toEqual([]);
    hub.announcements.set(false);expect(hub.filtered().map(g=>g.id)).toEqual(['team']);
  });
});
