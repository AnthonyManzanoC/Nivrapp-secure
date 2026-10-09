import { of, throwError } from 'rxjs';
import { ChatService } from './chat.service';

describe('message identity gate',()=>{
  function harness(){
    const service:any=Object.create(ChatService.prototype);
    const encrypt=jasmine.createSpy('encrypt').and.resolveTo({ciphertext:'sealed',header:{}});
    service.auth={session:()=>({user:{id:'self',alias:'self'},device:{id:'phone'}})};
    service.crypto={currentKeyMaterial:async()=>({publicJwk:{}}),parsePublicJwk:()=>({}),encryptForPublicKey:encrypt};
    service.identityTrust={check:jasmine.createSpy('check').and.resolveTo()};
    service.contacts=()=>[];
    service.api={post:jasmine.createSpy('post').and.returnValue(of([
      {userId:'self',devices:[{deviceId:'phone',keyBundle:{identityKey:'self'}}]},
      {userId:'peer',devices:[{deviceId:'other',keyBundle:{identityKey:'peer'}}]},
    ]))};
    const conversation={type:'Direct',participants:[{userId:'self'},{userId:'peer',displayName:'My old contact'}]};
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
  it('delivers to every published device while ignoring legacy sessions with no published key',async()=>{
    const {service,encrypt,conversation}=harness();
    service.api.post.and.returnValue(of([
      {userId:'self',devices:[{deviceId:'phone',keyBundle:{identityKey:'self'}},{deviceId:'legacy-self',keyBundle:{identityKey:null}}]},
      {userId:'peer',devices:[{deviceId:'other',keyBundle:{identityKey:'peer'}},{deviceId:'legacy-peer',keyBundle:{identityKey:''}}]},
    ]));
    const result=await service.encryptedRecipients(conversation,{type:'text',text:'private'});
    expect(result.map((recipient:any)=>recipient.deviceId)).toEqual(['phone','other']);expect(encrypt).toHaveBeenCalledTimes(2);
  });
  it('names a contact with no published device and blocks delivery without dropping that participant',async()=>{
    const {service,encrypt,conversation}=harness();
    service.api.post.and.returnValue(of([{userId:'self',devices:[{deviceId:'phone',keyBundle:{identityKey:'self'}}]},{userId:'peer',devices:[{deviceId:'legacy-peer',keyBundle:{identityKey:null}}]}]));
    await expectAsync(service.encryptedRecipients(conversation,{type:'text',text:'private'})).toBeRejectedWithError(/My old contact.*dispositivo autorizado/);
    expect(encrypt).not.toHaveBeenCalled();
  });
  it('refuses a malformed published key even if another contact device is healthy',async()=>{
    const {service,encrypt,conversation}=harness();service.crypto.parsePublicJwk=(key:string)=>key==='malformed'?null:{};
    service.api.post.and.returnValue(of([{userId:'self',devices:[{deviceId:'phone',keyBundle:{identityKey:'self'}}]},{userId:'peer',devices:[{deviceId:'other',keyBundle:{identityKey:'peer'}},{deviceId:'bad',keyBundle:{identityKey:'malformed'}}]}]));
    await expectAsync(service.encryptedRecipients(conversation,{type:'text',text:'private'})).toBeRejectedWithError(/My old contact/);
    expect(encrypt).not.toHaveBeenCalled();
  });
  it('republishes only its own missing bundle before fetching a fresh directory and encrypting',async()=>{
    const {service,encrypt,conversation}=harness(); const own={kty:'EC',crv:'P-256',x:'own-x',y:'own-y'}; const bundle={identityKey:'repaired-own'};
    service.crypto.currentKeyMaterial=async()=>({publicJwk:own,keyBundle:bundle});
    service.crypto.parsePublicJwk=(value:string)=>value==='repaired-own'?own:value==='peer'?{kty:'EC',crv:'P-256',x:'peer-x',y:'peer-y'}:null;
    service.api.post.and.returnValues(of([{userId:'self',devices:[]},{userId:'peer',devices:[{deviceId:'other',keyBundle:{identityKey:'peer'}}]}]),of({}),of([{userId:'self',devices:[{deviceId:'phone',keyBundle:bundle}]}]));
    const result=await service.encryptedRecipients(conversation,{type:'text',text:'private'});
    expect(service.api.post.calls.allArgs().map((args:any[])=>args[0])).toEqual(['/keys/batch','/keys/prekeys','/keys/batch']);
    expect(service.api.post.calls.argsFor(1)[1]).toBe(bundle);expect(encrypt).toHaveBeenCalledTimes(2);expect(result.length).toBe(2);
  });
});
