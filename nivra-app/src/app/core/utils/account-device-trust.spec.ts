import { PublicKeyDirectory } from '../models/nivra.models';
import { IdentityTrustService } from '../services/identity-trust.service';
import { checkedAccountDevices } from './account-device-trust';
import { AccountDeviceCertificate, AccountRootPublic, accountDeviceStatement, createAccountIdentity, signAccountIdentity } from './account-identity';

describe('account root and signed subdevices',()=>{
  async function fixture(){
    const secret=await createAccountIdentity('peer'),legacy=await createAccountIdentity('legacy');
    const root:AccountRootPublic={v:1,rootKey:secret.rootKey,sourceDeviceId:'phone',sourceHybrid:btoa('s'.repeat(64)),sourceLegacy:legacy.rootKey,endorsement:btoa('e'.repeat(64))};
    const device=async(id:string)=>{const key=id==='phone'?legacy:await createAccountIdentity(id);const certificate:AccountDeviceCertificate={v:1,rootKey:secret.rootKey,deviceId:id,legacyKey:key.rootKey,hybridKey:id==='phone'?root.sourceHybrid:btoa('b'.repeat(64)),signature:''};certificate.signature=await signAccountIdentity(secret,accountDeviceStatement('peer',certificate));const [x,y]=key.rootKey.split(':');return {deviceId:id,deviceName:id,lastRotatedAt:'',accountCertificate:certificate,keyBundle:{identityKey:JSON.stringify({kty:'EC',crv:'P-256',x,y}),signedPreKey:null,preKeySignature:null,oneTimePreKeys:[]}};};
    const phone=await device('phone'),browser=await device('browser');
    const directory:PublicKeyDirectory={userId:'peer',alias:'peer',accountIdentity:root,devices:[phone,browser]};
    const peers={phone:{userId:'peer',identityKey:root.sourceHybrid,legacy:root.sourceLegacy}};
    return {directory,device,phone,browser,root,peers};
  }
  it('migrates an authenticated old device to its account root and trusts later reinstallations after all old devices are removed',async()=>{
    const f=await fixture(),trust=new IdentityTrustService(),scope=crypto.randomUUID();
    await trust.confirm(scope,{...f.directory,accountIdentity:null,devices:[f.phone]});
    const proofs=await checkedAccountDevices(f.directory,f.peers,async()=>true);
    expect((await trust.forDelivery(scope,f.directory,()=>true,proofs)).devices.length).toBe(2);
    const reinstalled={...f.directory,devices:[await f.device('reinstalled')]};
    const renewed=await checkedAccountDevices(reinstalled,{},async()=>false);
    expect(renewed[0].rootEndorsed).toBeFalse();
    expect((await trust.forDelivery(scope,reinstalled,()=>true,renewed)).devices[0].deviceId).toBe('reinstalled');
    expect(trust.isChanged(scope,'peer')).toBeFalse();
  });
  it('does not let a self-signed root claim an already verified contact without the previous signing-key endorsement',async()=>{
    const f=await fixture(),trust=new IdentityTrustService(),scope=crypto.randomUUID();
    await trust.confirm(scope,{...f.directory,accountIdentity:null,devices:[f.phone]});
    const proofs=await checkedAccountDevices(f.directory,{},async()=>false);
    expect((await trust.forDelivery(scope,f.directory,()=>true,proofs)).devices.map(d=>d.deviceId)).toEqual(['phone']);
    const onlyBrowser={...f.directory,devices:[f.browser]};
    await expectAsync(trust.forDelivery(scope,onlyBrowser,()=>true,proofs)).toBeRejected();
  });
  it('rejects modified certificates and root replacements while preserving fresh-address rules',async()=>{
    const f=await fixture();
    const forged={...f.directory,devices:[{...f.browser,accountCertificate:{...f.browser.accountCertificate!,deviceId:'other'}}]};
    expect(await checkedAccountDevices(forged,f.peers,async()=>true)).toEqual([]);
    const trust=new IdentityTrustService(),scope=crypto.randomUUID();
    await trust.forDelivery(scope,f.directory,()=>true,await checkedAccountDevices(f.directory,{},async()=>false));
    const replacement={...await f.device('phone'),deviceId:'phone'};
    // A changed key at an existing DeviceId remains a hard error, even with a root signature.
    const changed={...f.directory,devices:[{...f.browser,deviceId:'phone',accountCertificate:{...f.browser.accountCertificate!,deviceId:'phone'}}]};
    await expectAsync(trust.forDelivery(scope,changed,()=>true,[])).toBeRejected();
    await expectAsync(trust.forDelivery(scope,{...f.directory,accountIdentity:{...f.root,rootKey:(await createAccountIdentity('rogue')).rootKey}},()=>true,[])).toBeRejected();
    expect(replacement.deviceId).toBe('phone');
  });
});
