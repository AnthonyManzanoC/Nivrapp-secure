import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/spanish.js';
import { continuityCoordinates } from './device-continuity';

export interface AccountRootPublic { v: 1; rootKey: string; sourceDeviceId: string; sourceHybrid: string; sourceLegacy: string; endorsement: string; }
export interface AccountDeviceCertificate { v: 1; rootKey: string; deviceId: string; legacyKey: string; hybridKey: string; signature: string; }
export interface AccountIdentitySecret { v: 1; userId: string; rootKey: string; privateJwk: JsonWebKey; recoveryEntropy: string; }
export interface AccountBackup { v: 1; method: 'password' | 'recovery'; salt: string; iv: string; ciphertext: string; iterations: number; }
export interface AccountIdentityBackup { identity: AccountRootPublic; passwordBackup: string; recoveryBackup: string; revision: number; }
const encoder = new TextEncoder();
export const identityBytes = (value: unknown): Uint8Array<ArrayBuffer> => encoder.encode(JSON.stringify(value));
export function identityB64(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
export function identityBinary(text: string, limit = 16384): Uint8Array<ArrayBuffer> {
  if (typeof text !== 'string' || text.length > limit || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw Error('Formato de identidad inválido.');
  const bytes = Uint8Array.from(atob(text), value => value.charCodeAt(0));
  if (identityB64(bytes) !== text) throw Error('Codificación de identidad inválida.');
  return bytes;
}
export function accountRootStatement(userId: string, root: Omit<AccountRootPublic, 'endorsement'>): Uint8Array<ArrayBuffer> {
  return identityBytes(['nivra-account-root-v1', userId, root.rootKey, root.sourceDeviceId, root.sourceHybrid, root.sourceLegacy]);
}
export function accountDeviceStatement(userId: string, certificate: Omit<AccountDeviceCertificate, 'signature'>): Uint8Array<ArrayBuffer> {
  return identityBytes(['nivra-account-device-v1', userId, certificate.rootKey, certificate.deviceId, certificate.legacyKey, certificate.hybridKey]);
}
export function accountBackupStatement(userId: string, backup: AccountIdentityBackup): Uint8Array<ArrayBuffer> {
  const root = backup.identity;
  return identityBytes(['nivra-account-backup-v1', userId, root.rootKey, root.sourceDeviceId, root.sourceHybrid, root.sourceLegacy, root.endorsement, backup.revision, backup.passwordBackup, backup.recoveryBackup]);
}
export function rootPublicJwk(rootKey: string): JsonWebKey {
  if (!continuityCoordinates.test(rootKey)) throw Error('Identidad raíz inválida.');
  const [x,y] = rootKey.split(':'); return { kty:'EC', crv:'P-256', x, y, ext:true };
}
export async function signAccountIdentity(secret: AccountIdentitySecret, message: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', {...secret.privateJwk,key_ops:['sign']}, {name:'ECDSA',namedCurve:'P-256'}, false, ['sign']);
  return identityB64(new Uint8Array(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'}, key, message)));
}
export async function verifyAccountIdentity(rootKey: string, message: Uint8Array<ArrayBuffer>, signature: string): Promise<boolean> {
  try {
    const bytes = identityBinary(signature,88); if(bytes.length!==64)return false;
    const key = await crypto.subtle.importKey('jwk', rootPublicJwk(rootKey), {name:'ECDSA',namedCurve:'P-256'}, false, ['verify']);
    return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,bytes,message);
  } catch { return false; }
}
export async function createAccountIdentity(userId: string): Promise<AccountIdentitySecret> {
  const pair = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk',pair.privateKey);
  return {v:1,userId,rootKey:`${privateJwk.x}:${privateJwk.y}`,privateJwk,recoveryEntropy:identityB64(crypto.getRandomValues(new Uint8Array(32)))};
}
export function accountRecoveryPhrase(secret: AccountIdentitySecret): string { return entropyToMnemonic(identityBinary(secret.recoveryEntropy,44),wordlist).normalize('NFC'); }
function recoveryMaterial(phrase: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(mnemonicToEntropy(phrase.trim().toLocaleLowerCase('es').normalize('NFKD').split(/\s+/u).join(' '),wordlist));
  if(bytes.length!==32)throw Error('Introduce las 24 palabras de recuperación.'); return bytes;
}
async function backupKey(material: string | Uint8Array<ArrayBuffer>, envelope: AccountBackup): Promise<CryptoKey> {
  const bytes = typeof material === 'string' ? encoder.encode(material) : material;
  try {
    const key = await crypto.subtle.importKey('raw',bytes,envelope.method==='password'?'PBKDF2':'HKDF',false,['deriveKey']);
    const salt = identityBinary(envelope.salt,44);
    return await crypto.subtle.deriveKey(envelope.method==='password'
      ? {name:'PBKDF2',hash:'SHA-256',salt,iterations:600000}
      : {name:'HKDF',hash:'SHA-256',salt,info:encoder.encode('nivra-account-recovery-v1')},key,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  } finally { bytes.fill(0); }
}
function backupAad(userId:string,rootKey:string,method:string):Uint8Array<ArrayBuffer>{return identityBytes(['nivra-account-secret-v1',userId,rootKey,method]);}
export async function sealAccountBackup(secret: AccountIdentitySecret, password: string, method: 'password' | 'recovery'): Promise<string> {
  const envelope: AccountBackup = {v:1,method,salt:identityB64(crypto.getRandomValues(new Uint8Array(32))),iv:identityB64(crypto.getRandomValues(new Uint8Array(12))),ciphertext:'',iterations:method==='password'?600000:0};
  const key = await backupKey(method==='password'?password:identityBinary(secret.recoveryEntropy,44),envelope);
  const plain = identityBytes(secret);
  try { envelope.ciphertext=identityB64(new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:identityBinary(envelope.iv,16),additionalData:backupAad(secret.userId,secret.rootKey,method)},key,plain))); }
  finally { plain.fill(0); }
  return JSON.stringify(envelope);
}
export async function openAccountBackup(userId:string,rootKey:string,serialized:string,credential:string,method:'password'|'recovery'):Promise<AccountIdentitySecret>{
  if(serialized.length>16384)throw Error('Copia de identidad inválida.'); const envelope=JSON.parse(serialized) as AccountBackup;
  if(envelope.v!==1||envelope.method!==method||envelope.iterations!==(method==='password'?600000:0)||identityBinary(envelope.salt,44).length!==32||identityBinary(envelope.iv,16).length!==12)throw Error('Copia de identidad inválida.');
  const key=await backupKey(method==='password'?credential:recoveryMaterial(credential),envelope);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:identityBinary(envelope.iv,16),additionalData:backupAad(userId,rootKey,method)},key,identityBinary(envelope.ciphertext));
  try {
    const secret=JSON.parse(new TextDecoder().decode(plain)) as AccountIdentitySecret;
    if(secret.v!==1||secret.userId!==userId||secret.rootKey!==rootKey||`${secret.privateJwk.x}:${secret.privateJwk.y}`!==rootKey||identityBinary(secret.recoveryEntropy,44).length!==32)throw Error('La copia pertenece a otra identidad.');
    const challenge=identityBytes(['nivra-account-restore-check',userId,rootKey]);
    if(!await verifyAccountIdentity(rootKey,challenge,await signAccountIdentity(secret,challenge)))throw Error('La copia no contiene la llave de esta identidad.');
    return secret;
  } finally { new Uint8Array(plain).fill(0); }
}
