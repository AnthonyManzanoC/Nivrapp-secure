import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { FriendRequestsComponent } from './friend-requests.component';

describe('Contact request actions', () => {
  let page: FriendRequestsComponent, social: any;
  const session = signal<any>(null);
  beforeEach(() => {
    session.set({user:{id:'alice'},device:{id:'phone'}});
    social = {accept:jasmine.createSpy().and.resolveTo(),reject:jasmine.createSpy().and.resolveTo(),cancel:jasmine.createSpy().and.resolveTo(),connectionActions:signal([])};
    TestBed.configureTestingModule({providers:[{provide:AuthService,useValue:{session}},{provide:SocialService,useValue:social},{provide:TranslateService,useValue:{instant:(_key:string,fallback:string)=>fallback}}]});
    page=TestBed.runInInjectionContext(()=>new FriendRequestsComponent());TestBed.flushEffects();
  });
  afterEach(()=>page.ngOnDestroy());
  it('serializes conflicting actions for the same request',async()=>{
    let done!:()=>void;
    social.accept.and.returnValue(new Promise<void>(resolve=>done=resolve));
    const pending=page.accept('one');await page.accept('one');await page.reject('one');
    expect(social.accept).toHaveBeenCalledTimes(1);expect(social.reject).not.toHaveBeenCalled();
    done();await pending;await page.reject('one');expect(social.reject).toHaveBeenCalledTimes(1);
  });
  it('ignores old errors after changing accounts',async()=>{
    let reject!:(error:Error)=>void;
    social.accept.and.returnValue(new Promise<void>((_resolve,failed)=>reject=failed));
    const pending=page.accept('one');
    session.set({user:{id:'bob'},device:{id:'new'}});TestBed.flushEffects();
    reject(new Error('old'));await pending;expect(page.error).toBe('');
  });
  it('searches the other person, including accented names and outgoing recipients',()=>{
    const request:any={from:{id:'alice',alias:'alice'},to:{id:'sofia',alias:'studio',displayName:'Sofía'}};
    page.query='sofia';expect(page.filteredRequests([request])).toEqual([request]);
    page.query='studio';expect(page.filteredRequests([request])).toEqual([request]);
    page.query='alice';expect(page.filteredRequests([request])).toEqual([]);
  });
});
