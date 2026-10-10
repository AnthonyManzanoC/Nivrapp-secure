import { IdentityTrustService } from './identity-trust.service';
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
});
