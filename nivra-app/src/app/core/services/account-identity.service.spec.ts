import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { from, of, Subject } from 'rxjs';
import { AccountIdentityService } from './account-identity.service';
import { NivraApiService } from './nivra-api.service';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { LocalHistoryService } from './local-history.service';
import { AccountIdentityBackup, accountBackupStatement, verifyAccountIdentity } from '../utils/account-identity';

describe('account identity lifecycle across devices',()=>{
  let service:AccountIdentityService,session:any,api:any,backup:AccountIdentityBackup|null,storage:Map<string,any>,certificates:any[];
  const context={hybridIdentity:btoa('h'.repeat(64)),legacyIdentity:'A'.repeat(43)+':'+'B'.repeat(43),endorse:async()=>btoa('s'.repeat(64))};
  beforeEach(()=>{
    backup=null;storage=new Map();certificates=[];session=signal({user:{id:'alice',alias:'alice'},device:{id:'phone'}});
    api={get:jasmine.createSpy().and.callFake(()=>of(structuredClone(backup))),post:jasmine.createSpy().and.callFake((path:string,body:any)=>{
      if(path.endsWith('/device')){certificates.push(structuredClone(body));return of(null);}
      return from((async()=>{
        if(!await verifyAccountIdentity(body.identity.rootKey,accountBackupStatement('alice',body),body.signature))throw Error('Invalid ownership proof');
        if(backup&&(body.identity.rootKey!==backup.identity.rootKey||body.revision!==backup.revision))throw {status:409};
        backup={identity:body.identity,passwordBackup:body.passwordBackup,recoveryBackup:body.recoveryBackup,revision:(backup?.revision??0)+1};return structuredClone(backup);
      })());
    })};
    TestBed.configureTestingModule({providers:[AccountIdentityService,{provide:AuthService,useValue:{session,sessionGeneration:signal(1)}},{provide:NivraApiService,useValue:api},{provide:AppLockService,useValue:{isContentLocked:signal(false)}},{provide:LocalHistoryService,useValue:{readRatchetState:async(u:string,d:string)=>structuredClone(storage.get(u+':'+d)??null),commitRatchetState:async(u:string,d:string,revision:number,state:any)=>{const key=u+':'+d;if((storage.get(key)?.revision??0)!==revision)throw Error('CAS conflict');storage.set(key,{revision:revision+1,state:structuredClone(state)});return revision+1;}}}]});
    service=TestBed.inject(AccountIdentityService);TestBed.flushEffects();
  });
  it('restores one root after deleting all local device state and certifies a fresh device independently of history',async()=>{
    await service.activate('account password',context);const firstRoot=backup!.identity.rootKey;
    storage.clear();session.set({user:{id:'alice',alias:'alice'},device:{id:'new-browser'}});TestBed.flushEffects();
    await service.activate('account password',context);
    expect(backup!.identity.rootKey).toBe(firstRoot);expect(certificates.map(c=>c.deviceId)).toEqual(['phone','new-browser']);expect(certificates[1].rootKey).toBe(firstRoot);
    expect([...storage.keys()]).toEqual(['alice:account-identity:new-browser']);
  });
  it('recovers with the backup phrase after a password reset and keeps the same account identity',async()=>{
    await service.activate('old password',context);const root=backup!.identity.rootKey,phrase=await service.phrase();
    storage.clear();session.set({user:{id:'alice',alias:'alice'},device:{id:'reinstalled-apk'}});TestBed.flushEffects();
    await expectAsync(service.activate('new password',context)).toBeRejected();expect(backup!.identity.rootKey).toBe(root);
    await service.activate('new password',context,phrase);expect(backup!.identity.rootKey).toBe(root);expect(backup!.revision).toBe(2);expect(await service.phrase()).toBe(phrase);
  });
  it('transfers the account root through an approved device handoff without requiring any message history',async()=>{
    await service.activate('account password',context);const transfer=await service.exportForDevice();
    session.set({user:{id:'alice',alias:'alice'},device:{id:'linked-exe'}});TestBed.flushEffects();
    await service.importForDevice(transfer!);await service.certify(context);expect(certificates.at(-1).deviceId).toBe('linked-exe');expect(await service.phrase()).toBeTruthy();
  });
  it('discards a delayed secret restoration when a second account becomes active',async()=>{
    await service.activate('account password',context);const snapshot=structuredClone(backup);
    session.set({user:{id:'alice',alias:'alice'},device:{id:'browser'}});TestBed.flushEffects();
    const pending=new Subject<any>();api.get.and.returnValue(pending);const restoring=service.activate('account password',context);
    session.set({user:{id:'bob',alias:'bob'},device:{id:'bob-phone'}});TestBed.flushEffects();pending.next(snapshot);pending.complete();await expectAsync(restoring).toBeRejected();
    expect(storage.has('bob:account-identity:bob-phone')).toBeFalse();expect(certificates.length).toBe(1);expect(service.state()).toBe('password');
  });
});
