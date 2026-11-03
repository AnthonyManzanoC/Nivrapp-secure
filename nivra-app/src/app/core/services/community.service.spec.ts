import { signal } from '@angular/core';
import { fakeAsync, TestBed, tick } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { CommunityService } from './community.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

describe('Communities ownership and network retries',()=>{
  let service:CommunityService, api:any, chat:any, session:ReturnType<typeof signal<any>>, generation:ReturnType<typeof signal<number>>;
  let events: Subject<{type: string; payload: unknown}>;
  const item={id:'community-A',name:'Familia',description:'Avisos',photo:null,role:'Owner',memberCount:2,updatedAt:'2026-11-02',groups:[]};
  const draft={name:'Familia',description:'Avisos',photo:null,groupIds:[]};
  const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
  beforeEach(async()=>{
    session=signal<any>({user:{id:'A'},device:{id:'phone-A'}});generation=signal(1);
    api={get:jasmine.createSpy().and.returnValue(of([item])),post:jasmine.createSpy().and.returnValue(of(item)),patch:jasmine.createSpy().and.returnValue(of(item)),delete:jasmine.createSpy().and.returnValue(of(null))};
    chat={refreshChats:jasmine.createSpy().and.resolveTo()};
    events=new Subject();
    TestBed.configureTestingModule({providers:[CommunityService,{provide:AuthService,useValue:{session,sessionGeneration:generation}},{provide:NivraApiService,useValue:api},{provide:ChatService,useValue:chat},{provide:SignalrService,useValue:{events$:events}}]});
    service=TestBed.inject(CommunityService);TestBed.flushEffects();await settle();
  });
  afterEach(()=>TestBed.resetTestingModule());
  it('conceals communities synchronously on account or session generation changes',()=>{
    expect(service.items().length).toBe(1);generation.update(n=>n+1);expect(service.items()).toEqual([]);
    TestBed.flushEffects();session.set({user:{id:'B'},device:{id:'phone-B'}});expect(service.items()).toEqual([]);
  });
  it('drops a late response from another account',async()=>{
    const response=new Subject<any>();api.get.and.returnValue(response);const pending=service.load();
    session.set({user:{id:'B'},device:{id:'phone-B'}});generation.update(n=>n+1);
    response.next([item]);response.complete();await pending;expect(service.items()).toEqual([]);
  });
  it('does not erase the directory when only the access token refreshes',()=>{
    api.get.calls.reset();session.update(s=>({...s,tokens:{accessToken:'renewed'}}));TestBed.flushEffects();
    expect(api.get).not.toHaveBeenCalled();expect(service.items()[0].id).toBe(item.id);
  });
  it('ignores 100 unrelated updates and batches community events behind one in-flight read',fakeAsync(()=>{
    api.get.calls.reset();
    for(let i=0;i<100;i++) events.next({type:'conversation.updated',payload:{id:'unrelated-'+i}});
    tick(250);
    expect(api.get).not.toHaveBeenCalled();

    const slow=new Subject<unknown>();
    const updated={...item,name:'Familia renovada'};
    api.get.and.returnValues(slow,of([updated]));
    const first=service.load();
    expect(service.load()).toBe(first);
    for(let i=0;i<40;i++) events.next({type:'community.changed',payload:{communityId:item.id}});
    tick(250);
    expect(api.get).toHaveBeenCalledTimes(1);
    slow.next([]);
    slow.complete();
    tick();
    expect(api.get).toHaveBeenCalledTimes(2);
    expect(service.items()).toEqual([updated]);
  }));
  it('restores the directory when connectivity returns',fakeAsync(()=>{
    api.get.and.returnValue(throwError(()=>({status:0})));
    void service.load();
    tick();
    expect(service.error()).toContain('conexión');
    api.get.and.returnValue(of([{...item,name:'En línea'}]));
    window.dispatchEvent(new Event('online'));
    tick(250);
    expect(service.items()[0].name).toBe('En línea');
    expect(service.error()).toBe('');
  }));
  it('reuses a request ID after a connection failure',async()=>{
    api.post.and.returnValue(throwError(()=>({status:0})));expect(await service.create(draft)).toBeNull();
    const first=api.post.calls.mostRecent().args[1].requestId;
    api.post.and.returnValue(of(item));expect(await service.create(draft)).toEqual(item);
    expect(api.post.calls.mostRecent().args[1].requestId).toBe(first);
  });
  it('creates a new intent when the user deliberately changes the creation draft',async()=>{
    api.post.and.returnValue(throwError(()=>({status:0})));await service.create(draft);
    const first=api.post.calls.mostRecent().args[1].requestId;await service.create({...draft,name:'Otra comunidad'});
    expect(api.post.calls.mostRecent().args[1].requestId).not.toBe(first);
  });
  it('retains a committed creation even when directory and chat refresh fail',async()=>{
    const created={...item,id:'created'};api.post.and.returnValue(of(created));api.get.and.returnValue(throwError(()=>({status:0})));chat.refreshChats.and.rejectWith(new Error('offline'));
    expect(await service.create(draft)).toEqual(created);expect(service.items().some(c=>c.id==='created')).toBeTrue();
  });
  it('finishes creation while the old directory read is still waiting',async()=>{
    const slow=new Subject<unknown>();
    const created={...item,id:'created'};
    api.get.and.returnValues(slow,of([created]));
    api.post.and.returnValue(of(created));
    const first=service.load();
    expect(await service.create(draft)).toEqual(created);
    expect(service.busy()).toBe('');
    expect(service.items().some(c=>c.id===created.id)).toBeTrue();
    slow.next([item]);
    slow.complete();
    await first;
    expect(service.items()).toEqual([created]);
  });
  it('serializes duplicate clicks and ignores a completed mutation after account changes',async()=>{
    const response=new Subject<any>();api.post.and.returnValue(response);const pending=service.create(draft);
    expect(await service.create(draft)).toBeNull();expect(api.post).toHaveBeenCalledTimes(1);
    session.set({user:{id:'B'},device:{id:'phone-B'}});generation.update(n=>n+1);response.next(item);response.complete();
    expect(await pending).toBeNull();expect(chat.refreshChats).not.toHaveBeenCalled();expect(service.items()).toEqual([]);
  });
  it('reuses a child-group intent after an ambiguous network failure',async()=>{
    api.post.and.returnValue(throwError(()=>({status:0})));await service.createGroup(item.id,'Tema',[]);
    const first=api.post.calls.mostRecent().args[1].requestId;await service.createGroup(item.id,'Tema',[]);
    expect(api.post.calls.mostRecent().args[1].requestId).toBe(first);
  });
});
