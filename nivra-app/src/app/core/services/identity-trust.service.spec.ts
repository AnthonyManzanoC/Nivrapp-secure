import { IdentityTrustService, IdentityTrustTransfer } from './identity-trust.service';
import { PublicKeyDirectory } from '../models/nivra.models';

const directory = (coordinate: string): PublicKeyDirectory => ({userId:'peer',alias:'peer',devices:[{
  deviceId:'phone',deviceName:'phone',lastRotatedAt:'2026-10-03T00:00:00Z',
  keyBundle:{identityKey:JSON.stringify({kty:'EC',crv:'P-256',x:coordinate.repeat(43),y:'B'.repeat(43)}),signedPreKey:null,preKeySignature:null,oneTimePreKeys:[]},
}]});
describe('persistent identity pins',()=>{
  it('remembers the first directory after service recreation and blocks a changed identity',async()=>{
    const scope=crypto.randomUUID();await new IdentityTrustService().check(scope,directory('A'));
    await expectAsync(new IdentityTrustService().check(scope,directory('A'))).toBeResolved();
    await expectAsync(new IdentityTrustService().check(scope,directory('C'))).toBeRejectedWithError(/identidad.*cambiado/);
  });
  it('only accepts a changed identity after explicit confirmation and isolates accounts',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();await service.check(scope,directory('A'));
    await expectAsync(service.check(scope+'other',directory('C'))).toBeResolved();
    await service.confirm(scope,directory('C'));await expectAsync(service.check(scope,directory('C'))).toBeResolved();
    await expectAsync(service.check(scope,directory('A'))).toBeRejected();
  });
  it('serializes competing first-use writes so two different identities cannot both be accepted',async()=>{
    const scope=crypto.randomUUID();const results=await Promise.allSettled([new IdentityTrustService().check(scope,directory('A')),new IdentityTrustService().check(scope,directory('C'))]);
    expect(results.filter(x=>x.status==='fulfilled').length).toBe(1);
    expect(results.filter(x=>x.status==='rejected').length).toBe(1);
  });
  it('checks continuity without creating a pin or promoting first use into verified identity',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();
    expect((await service.continuity(scope,directory('A'))).state).toBe('unknown');
    await service.check(scope,directory('C'));
    expect((await service.continuity(scope,directory('C'))).state).toBe('unchanged');
    expect((await service.continuity(scope,directory('A'))).state).toBe('changed');
    await expectAsync(service.check(scope,directory('A'))).toBeRejected();
  });
  it('reports an independently compared pin only while fresh keys still match and retains its date',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();
    await service.confirm(scope,directory('A'));
    const same=await new IdentityTrustService().continuity(scope,directory('A'));
    expect(same.state).toBe('verified');expect(same.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await service.continuity(scope,directory('C'))).state).toBe('changed');
    expect((await service.continuity(scope+'other',directory('A'))).state).toBe('unknown');
    expect((await service.continuity(scope,directory('A'))).state).toBe('verified');
  });
  it('never writes the comparison when its page scope was canceled',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();
    await expectAsync(service.confirm(scope,directory('A'),()=>false)).toBeRejected();
    expect((await service.continuity(scope,directory('A'))).state).toBe('unknown');
  });
  it('rechecks the live comparison inside the storage transaction',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();let calls=0;
    await expectAsync(service.confirm(scope,directory('A'),()=>++calls===1)).toBeRejected();
    expect(calls).toBe(2);
    expect((await service.continuity(scope,directory('A'))).state).toBe('unknown');
  });
  it('keeps trusted remaining devices when a known device is revoked, but never accepts a new or replaced key',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();const original=directory('A');
    original.devices.push({...directory('C').devices[0],deviceId:'laptop'});
    await service.confirm(scope,original);
    await expectAsync(service.check(scope,directory('A'))).toBeResolved();
    expect((await service.continuity(scope,directory('A'))).state).toBe('verified');
    await expectAsync(service.check(scope,original)).toBeRejectedWithError(/identidad.*cambiado/);
    expect(service.isChanged(scope,'peer')).toBeTrue();
    await expectAsync(service.check(scope,directory('C'))).toBeRejected();
  });
  it('does not mistake a changed key plus a device removal for safe continuity',async()=>{
    const scope=crypto.randomUUID();const service=new IdentityTrustService();const original=directory('A');
    original.devices.push({...directory('C').devices[0],deviceId:'laptop'});
    await service.confirm(scope,original);
    expect((await service.continuity(scope,directory('C'))).state).toBe('changed');
    await expectAsync(service.check(scope,directory('C'))).toBeRejected();
  });
  it('restores an existing comparison on the linked owner while still blocking different fresh keys',async()=>{
    const owner=crypto.randomUUID();const source=JSON.stringify([owner,'phone']);const target=JSON.stringify([owner,'laptop']);
    const service=new IdentityTrustService();await service.confirm(source,directory('A'));
    const transferred=await service.exportForLinkedDevice(owner,'phone');
    expect(await service.importFromLinkedDevice(target,'phone',transferred)).toBe(1);
    const continuity=await new IdentityTrustService().continuity(target,directory('A'));
    expect(continuity.state).toBe('verified');expect(continuity.source).toBe('linked-device');expect(continuity.verifiedAt).toBeTruthy();
    await expectAsync(service.check(target,directory('C'))).toBeRejected();
    expect((await service.continuity(JSON.stringify([crypto.randomUUID(),'laptop']),directory('A'))).state).toBe('unknown');
  });
  it('exports only the exact account/device namespace and never turns first use into a human comparison',async()=>{
    const owner=crypto.randomUUID();const service=new IdentityTrustService();const source=JSON.stringify([owner,'phone']);
    await service.check(source,directory('A'));
    await service.confirm(JSON.stringify([crypto.randomUUID(),'phone']),{...directory('C'),userId:'other-owner-contact'});
    await service.confirm(JSON.stringify([owner,'other-device']),{...directory('C'),userId:'other-device-contact'});
    const transferred=await service.exportForLinkedDevice(owner,'phone');expect(transferred.entries.length).toBe(1);expect(transferred.entries[0].verified).toBeFalse();
    const target=JSON.stringify([owner,'laptop']);await service.importFromLinkedDevice(target,'phone',transferred);
    const continuity=await service.continuity(target,directory('A'));expect(continuity.state).toBe('unchanged');expect(continuity.verifiedAt).toBeUndefined();
  });
  it('cannot replace a locally observed identity with a delayed comparison from another linked device',async()=>{
    const owner=crypto.randomUUID();const service=new IdentityTrustService();const source=JSON.stringify([owner,'phone']);const target=JSON.stringify([owner,'laptop']);
    await service.confirm(source,directory('A'));const transferred=await service.exportForLinkedDevice(owner,'phone');
    await service.check(target,directory('C'));
    expect(await service.importFromLinkedDevice(target,'phone',transferred)).toBe(0);
    expect((await service.continuity(target,directory('C'))).state).toBe('unchanged');
    await expectAsync(service.check(target,directory('A'))).toBeRejected();
  });
  it('requires the approved source and owner and rejects malformed comparison metadata atomically',async()=>{
    const owner=crypto.randomUUID();const service=new IdentityTrustService();const source=JSON.stringify([owner,'phone']);const target=JSON.stringify([owner,'laptop']);
    await service.confirm(source,directory('A'));const transferred=await service.exportForLinkedDevice(owner,'phone');
    for(const malformed of [
      {...transferred,userId:crypto.randomUUID()},
      {...transferred,sourceDeviceId:'another-phone'},
      {...transferred,entries:[{...transferred.entries[0],verifiedAt:undefined}]},
      {...transferred,entries:[transferred.entries[0],transferred.entries[0]]},
      {...transferred,entries:[{...transferred.entries[0],digest:'invalid'}]},
    ])await expectAsync(service.importFromLinkedDevice(target,'phone',malformed as IdentityTrustTransfer)).toBeRejected();
    expect((await service.continuity(target,directory('A'))).state).toBe('unknown');
  });
  it('rolls back all comparison imports if account activation is canceled during the transaction',async()=>{
    const owner=crypto.randomUUID();const service=new IdentityTrustService();const source=JSON.stringify([owner,'phone']);const target=JSON.stringify([owner,'laptop']);
    await service.confirm(source,directory('A'));const transferred=await service.exportForLinkedDevice(owner,'phone');let checks=0;
    await expectAsync(service.importFromLinkedDevice(target,'phone',transferred,()=>++checks===1)).toBeRejected();
    expect(checks).toBe(2);expect((await service.continuity(target,directory('A'))).state).toBe('unknown');
  });
  it('can promote the same locally observed keys from an approved comparison without downgrading a local one',async()=>{
    const owner=crypto.randomUUID();const service=new IdentityTrustService();const source=JSON.stringify([owner,'phone']);const target=JSON.stringify([owner,'laptop']);
    await service.confirm(source,directory('A'));const transferred=await service.exportForLinkedDevice(owner,'phone');
    await service.check(target,directory('A'));expect(await service.importFromLinkedDevice(target,'phone',transferred)).toBe(1);
    expect((await service.continuity(target,directory('A'))).source).toBe('linked-device');
    await service.confirm(target,directory('A'));expect(await service.importFromLinkedDevice(target,'phone',transferred)).toBe(0);
    expect((await service.continuity(target,directory('A'))).source).toBe('this-device');
  });
});
