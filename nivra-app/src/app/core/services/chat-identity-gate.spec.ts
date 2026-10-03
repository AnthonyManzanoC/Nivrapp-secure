import { of, throwError } from 'rxjs';
import { ChatService } from './chat.service';

describe('message identity gate',()=>{
  function harness(){
    const service:any=Object.create(ChatService.prototype);
    const encrypt=jasmine.createSpy('encrypt').and.resolveTo({ciphertext:'sealed',header:{}});
    service.auth={session:()=>({user:{id:'self',alias:'self'},device:{id:'phone'}})};
    service.crypto={currentKeyMaterial:async()=>({publicJwk:{}}),parsePublicJwk:()=>({}),encryptForPublicKey:encrypt};
    service.identityTrust={check:jasmine.createSpy('check').and.resolveTo()};
    service.api={post:jasmine.createSpy('post').and.returnValue(of([
      {userId:'self',devices:[{deviceId:'phone',keyBundle:{identityKey:'self'}}]},
      {userId:'peer',devices:[{deviceId:'other',keyBundle:{identityKey:'peer'}}]},
    ]))};
    const conversation={type:'Direct',participants:[{userId:'self'},{userId:'peer'}]};
    return {service,encrypt,conversation};
  }
  it('refuses to encrypt any recipient when the contact identity changed',async()=>{
    const {service,encrypt,conversation}=harness();service.identityTrust.check.and.rejectWith(new Error('changed'));
    await expectAsync(service.encryptedRecipients(conversation,{type:'text',text:'private'})).toBeRejectedWithError('changed');
    expect(encrypt).not.toHaveBeenCalled();
  });
  it('does not reuse cached keys when the fresh directory request fails',async()=>{
    const {service,encrypt,conversation}=harness();service.api.post.and.returnValue(throwError(()=>new Error('offline')));
    await expectAsync(service.encryptedRecipients(conversation,{type:'text',text:'private'})).toBeRejectedWithError('offline');
    expect(encrypt).not.toHaveBeenCalled();
  });
  it('encrypts normally after checking an unchanged contact',async()=>{
    const {service,encrypt,conversation}=harness();const result=await service.encryptedRecipients(conversation,{type:'text',text:'private'});
    expect(service.identityTrust.check).toHaveBeenCalled();expect(encrypt).toHaveBeenCalledTimes(2);expect(result.length).toBe(2);
  });
});
