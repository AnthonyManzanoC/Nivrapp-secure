import { accountDeviceStatement, accountRecoveryPhrase, createAccountIdentity, identityBytes, openAccountBackup, sealAccountBackup, signAccountIdentity, verifyAccountIdentity } from './account-identity';

describe('recoverable account identity cryptography',()=>{
  it('restores the same signing root through password and 24-word recovery without message keys',async()=>{
    const secret=await createAccountIdentity('alice'),password=await sealAccountBackup(secret,'correct horse battery staple','password'),recovery=await sealAccountBackup(secret,'','recovery');
    const phrase=accountRecoveryPhrase(secret);expect(phrase.split(' ').length).toBe(24);
    expect((await openAccountBackup('alice',secret.rootKey,password,'correct horse battery staple','password')).privateJwk.d).toBe(secret.privateJwk.d);
    expect((await openAccountBackup('alice',secret.rootKey,recovery,phrase,'recovery')).rootKey).toBe(secret.rootKey);
    expect(JSON.parse(password).ciphertext).not.toContain(secret.privateJwk.d!);
    expect(JSON.parse(password).iterations).toBe(600000);
  });
  it('rejects wrong passwords, account substitution, tampering and weaker KDF metadata',async()=>{
    const secret=await createAccountIdentity('alice'),backup=await sealAccountBackup(secret,'private password','password');
    await expectAsync(openAccountBackup('alice',secret.rootKey,backup,'wrong','password')).toBeRejected();
    await expectAsync(openAccountBackup('bob',secret.rootKey,backup,'private password','password')).toBeRejected();
    const altered=JSON.parse(backup);altered.iterations=1;
    await expectAsync(openAccountBackup('alice',secret.rootKey,JSON.stringify(altered),'private password','password')).toBeRejected();
    altered.iterations=600000;altered.ciphertext=(altered.ciphertext[0]==='A'?'B':'A')+altered.ciphertext.slice(1);
    await expectAsync(openAccountBackup('alice',secret.rootKey,JSON.stringify(altered),'private password','password')).toBeRejected();
  });
  it('binds a certificate to the account, fresh device address and both encryption identities',async()=>{
    const secret=await createAccountIdentity('alice');
    const certificate={v:1 as const,rootKey:secret.rootKey,deviceId:'browser-2',legacyKey:'legacy',hybridKey:'hybrid'};
    const signature=await signAccountIdentity(secret,accountDeviceStatement('alice',certificate));
    expect(await verifyAccountIdentity(secret.rootKey,accountDeviceStatement('alice',certificate),signature)).toBeTrue();
    expect(await verifyAccountIdentity(secret.rootKey,accountDeviceStatement('bob',certificate),signature)).toBeFalse();
    expect(await verifyAccountIdentity(secret.rootKey,accountDeviceStatement('alice',{...certificate,deviceId:'browser-3'}),signature)).toBeFalse();
    expect(await verifyAccountIdentity(secret.rootKey,accountDeviceStatement('alice',{...certificate,hybridKey:'substitution'}),signature)).toBeFalse();
    expect(await verifyAccountIdentity(secret.rootKey,identityBytes(['other-domain']),signature)).toBeFalse();
  });
});
