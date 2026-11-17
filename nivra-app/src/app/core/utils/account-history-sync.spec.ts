import { ChatMessageVm } from '../models/nivra.models';
import { createAccountIdentity, openAccountBackup, sealAccountBackup, signAccountIdentity } from './account-identity';
import { AccountHistoryEnvelope, accountHistoryStatement, openAccountHistory, sealAccountHistory } from './account-history-sync';

describe('root-backed account history',()=>{
  const message:ChatMessageVm={id:'msg_history_1',clientMessageId:'client_history_1',conversationId:'con_history',senderUserId:'alice',senderDeviceId:'apk_1',at:'2026-11-15T10:00:00.000Z',mine:true,payload:{type:'text',text:'Historia privada 🌿'}};
  it('restores history after every old device is gone using the recovered root, with independent ciphertext per backup',async()=>{
    const root=await createAccountIdentity('alice');
    const backup=await sealAccountBackup(root,'strong-fixture-password','password');
    const first=await sealAccountHistory(root,message),second=await sealAccountHistory(root,message);
    expect(first.iv).not.toBe(second.iv);expect(first.ciphertext).not.toBe(second.ciphertext);expect(first.ciphertext).not.toContain('Historia');
    const recovered=await openAccountBackup('alice',root.rootKey,backup,'strong-fixture-password','password');
    expect((await openAccountHistory(recovered,first)).payload).toEqual(message.payload);
    const mirrors=await Promise.all(['apk2','web','exe'].map(()=>openAccountHistory(recovered,first)));
    expect(mirrors.every(value=>JSON.stringify(value.payload)===JSON.stringify(message.payload))).toBeTrue();
  });
  it('rejects cross-account/cross-root replay, metadata substitution, malformed lengths and invalid signatures',async()=>{
    const root=await createAccountIdentity('alice'),foreign=await createAccountIdentity('bob');
    const row=await sealAccountHistory(root,message);
    await expectAsync(openAccountHistory(foreign,row)).toBeRejected();
    await expectAsync(openAccountHistory({...root,userId:'bob'},row)).toBeRejected();
    for(const patch of [{messageId:'other'}, {conversationId:'other'}, {senderDeviceId:'apk_fake'}, {at:'2026-11-16T10:00:00.000Z'}, {iv:'AAAA'}, {signature:'A'.repeat(88)}, {ciphertext:'AAAA'}]){
      await expectAsync(openAccountHistory(root,{...row,...patch})).toBeRejected();
    }
  });
  it('requires the AES-GCM tag even if a corrupted ciphertext was signed by the legitimate root',async()=>{
    const root=await createAccountIdentity('alice'),row=await sealAccountHistory(root,message);
    const corrupt:AccountHistoryEnvelope={...row,ciphertext:(row.ciphertext[0]==='A'?'B':'A')+row.ciphertext.slice(1)};
    corrupt.signature=await signAccountIdentity(root,accountHistoryStatement('alice',corrupt));
    await expectAsync(openAccountHistory(root,corrupt)).toBeRejected();
  });
  it('never archives one-view/deleted-after-read or expired messages, and handles large payloads without base64 stack overflow',async()=>{
    const root=await createAccountIdentity('alice');
    for(const patch of [{deleteAfterRead:true},{expiresAt:'2020-01-01T00:00:00Z'},{decryptError:true},{payload:{type:'view-once-opened'}}])await expectAsync(sealAccountHistory(root,{...message,...patch})).toBeRejected();
    const large={...message,payload:{type:'text',text:'a'.repeat(120000)}};
    expect((await openAccountHistory(root,await sealAccountHistory(root,large))).payload).toEqual(large.payload);
  });
});
