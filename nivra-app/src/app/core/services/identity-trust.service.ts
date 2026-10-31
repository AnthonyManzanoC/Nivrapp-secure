import { Injectable, signal } from '@angular/core';
import { PublicKeyDirectory } from '../models/nivra.models';
import { DirectoryFingerprint, deriveDirectoryFingerprint } from '../utils/identity-fingerprint';

interface Pin {
  digest: string;
  verified: boolean;
  verifiedAt?: string;
  devices?: DirectoryFingerprint['deviceIdentities'];
  linkedFromDeviceId?: string;
}

export interface IdentityTrustTransferEntry { userId: string; digest: string; verified: boolean; verifiedAt?: string; devices?: DirectoryFingerprint['deviceIdentities']; }
/** Public pins only, transported inside an explicitly approved E2EE handoff. */
export interface IdentityTrustTransfer {
  v: 1;
  purpose: 'identity-continuity';
  userId: string;
  sourceDeviceId: string;
  entries: IdentityTrustTransferEntry[];
}
export interface IdentityContinuity {
  state: 'unknown' | 'unchanged' | 'verified' | 'changed';
  verifiedAt?: string;
  source?: 'this-device' | 'linked-device';
}
const MAX_TRANSFER_ENTRIES = 512;
const MAX_TRANSFER_BYTES = 96 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
@Injectable({providedIn:'root'})
export class IdentityTrustService {
  private readonly changed = signal<ReadonlySet<string>>(new Set());
  isChanged(scope:string,userId:string):boolean { return this.changed().has(JSON.stringify([scope,userId])); }
  private database?: Promise<IDBDatabase>;
  private open():Promise<IDBDatabase>{
    return this.database ??= new Promise((resolve,reject)=>{
      const request=indexedDB.open('nivra-identity-trust',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('pins');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>{this.database=undefined;reject(request.error);};
    });
  }
  async check(scope:string,directory:PublicKeyDirectory,isCurrent:()=>boolean=()=>true):Promise<void>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    if(!isCurrent())throw new Error('La comprobación ya no está activa.');
    await this.update(scope,directory.userId,current=>{
      if(!isCurrent())throw new Error('La comprobación ya no está activa.');
      if(current && current.digest!==fingerprint.digest && !this.hasKnownEncryptionKeys(current,fingerprint)) {
        this.changed.update(previous=>new Set([...previous,JSON.stringify([scope,directory.userId])]));
        throw new Error('La identidad de este contacto ha cambiado. Abre Verificar identidad y compara el código antes de continuar.');
      }
      return {...current,digest:fingerprint.digest,verified:current?.verified??false,devices:fingerprint.deviceIdentities};
    });
    this.clearChanged(scope,directory.userId);
  }
  /** Read-only continuity against a local pin; this never establishes new trust. */
  async continuity(scope:string,directory:PublicKeyDirectory):Promise<IdentityContinuity>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    const db=await this.open();
    const pin=await new Promise<Pin|undefined>((resolve,reject)=>{
      const tx=db.transaction('pins','readonly');const request=tx.objectStore('pins').get(JSON.stringify([scope,directory.userId]));
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
      tx.onabort=()=>reject(tx.error || new Error('No se pudo comprobar la identidad.'));
    });
    if(!pin)return {state:'unknown'};
    if(pin.digest!==fingerprint.digest && !this.hasKnownEncryptionKeys(pin,fingerprint))return {state:'changed'};
    return {state:pin.verified?'verified':'unchanged',...(pin.verifiedAt?{verifiedAt:pin.verifiedAt}:{}),source:pin.linkedFromDeviceId?'linked-device':'this-device'};
  }
  async confirm(scope:string,directory:PublicKeyDirectory,isCurrent:()=>boolean=()=>true):Promise<void>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    if(!isCurrent())throw new Error('La comparación ya no está activa.');
    await this.update(scope,directory.userId,()=>{
      if(!isCurrent())throw new Error('La comparación ya no está activa.');
      return {digest:fingerprint.digest,devices:fingerprint.deviceIdentities,verified:true,verifiedAt:new Date().toISOString()};
    });
    this.clearChanged(scope,directory.userId);
  }

  /** Export this owner's exact source-device namespace; never another account's pins. */
  async exportForLinkedDevice(userId:string,sourceDeviceId:string):Promise<IdentityTrustTransfer>{
    if(!this.validId(userId)||!this.validId(sourceDeviceId))throw new Error('La cuenta de origen no es válida.');
    const scope=JSON.stringify([userId,sourceDeviceId]);
    const db=await this.open();
    const entries=await new Promise<IdentityTrustTransferEntry[]>((resolve,reject)=>{
      const prefix=`[${JSON.stringify(scope)},`;
      const tx=db.transaction('pins','readonly');const request=tx.objectStore('pins').openCursor(IDBKeyRange.bound(prefix,`${prefix}\uffff`));
      const found:IdentityTrustTransferEntry[]=[];
      request.onsuccess=()=>{
        const cursor=request.result;if(!cursor)return;
        try{
          const [ownerScope,contactId]=JSON.parse(String(cursor.key));const pin=cursor.value as Pin;
          if(ownerScope===scope && contactId!==userId && this.validEntry({...pin,userId:contactId}) && !this.isChanged(scope,contactId)){
            found.push({userId:contactId,digest:pin.digest,verified:pin.verified,...(pin.verifiedAt?{verifiedAt:pin.verifiedAt}:{}),...(pin.devices?{devices:pin.devices}: {})});
          }
        }catch{/* Unrelated legacy keys cannot establish continuity for this account. */}
        cursor.continue();
      };
      tx.oncomplete=()=>resolve(found);tx.onabort=()=>reject(tx.error||new Error('No se pudo preparar la continuidad de los contactos.'));tx.onerror=()=>reject(tx.error);
    });
    entries.sort((a,b)=>Number(b.verified)-Number(a.verified)||(b.verifiedAt??'').localeCompare(a.verifiedAt??'')||a.userId.localeCompare(b.userId));
    const transfer:IdentityTrustTransfer={v:1,purpose:'identity-continuity',userId,sourceDeviceId,entries:[]};
    const encoder=new TextEncoder();let bytes=encoder.encode(JSON.stringify(transfer)).byteLength;
    for(const entry of entries.slice(0,MAX_TRANSFER_ENTRIES)){
      const added=encoder.encode(JSON.stringify(entry)).byteLength+(transfer.entries.length?1:0);
      if(bytes+added>MAX_TRANSFER_BYTES)break;
      transfer.entries.push(entry);bytes+=added;
    }
    return transfer;
  }

  /** Use only after validating/decrypting the owner's approved QR/history handoff. */
  async importFromLinkedDevice(targetScope:string,sourceDeviceId:string,transfer:IdentityTrustTransfer,isCurrent:()=>boolean=()=>true):Promise<number>{
    let scope:unknown;
    try{scope=JSON.parse(targetScope);}catch{throw new Error('La cuenta de destino no es válida.');}
    if(!Array.isArray(scope)||scope.length!==2||!this.validId(scope[0])||!this.validId(scope[1])||!this.validId(sourceDeviceId)
      ||!transfer||transfer.v!==1||transfer.purpose!=='identity-continuity'||transfer.userId!==scope[0]||transfer.sourceDeviceId!==sourceDeviceId
      ||!Array.isArray(transfer.entries)||transfer.entries.length>MAX_TRANSFER_ENTRIES||new TextEncoder().encode(JSON.stringify(transfer)).byteLength>MAX_TRANSFER_BYTES)
      throw new Error('La continuidad de los contactos no corresponde a esta cuenta.');
    const entries=transfer.entries;const ids=new Set<string>();
    for(const entry of entries){
      if(!this.validEntry(entry)||entry.userId===transfer.userId||ids.has(entry.userId))throw new Error('El paquete de continuidad de los contactos no es válido.');
      if(entry.devices){
        const fingerprint=await deriveDirectoryFingerprint({userId:entry.userId,alias:'',devices:entry.devices.map(device=>{
          const [x,y]=device.identity.split(':');
          return {deviceId:device.deviceId,deviceName:'',lastRotatedAt:'',keyBundle:{identityKey:JSON.stringify({kty:'EC',crv:'P-256',x,y}),signedPreKey:null,preKeySignature:null,oneTimePreKeys:[]}};
        })});
        if(fingerprint.digest!==entry.digest)throw new Error('Las llaves de continuidad no coinciden con su comprobación.');
      }
      ids.add(entry.userId);
    }
    if(!isCurrent())throw new Error('La vinculación ya no está activa.');
    const db=await this.open();
    return new Promise<number>((resolve,reject)=>{
      const tx=db.transaction('pins','readwrite');const store=tx.objectStore('pins');let imported=0;let error:unknown;
      for(const entry of entries){
        const key=JSON.stringify([targetScope,entry.userId]);const request=store.get(key);
        request.onsuccess=()=>{
          try{
            if(!isCurrent())throw new Error('La vinculación ya no está activa.');
            const current=request.result as Pin|undefined;
            // A delayed handoff must not erase a different identity already observed here.
            if(current&&(current.digest!==entry.digest||current.verified||!entry.verified))return;
            store.put({...current,digest:entry.digest,verified:entry.verified,...(entry.verifiedAt?{verifiedAt:entry.verifiedAt}:{}),...(entry.devices?{devices:entry.devices}:{}),linkedFromDeviceId:sourceDeviceId} satisfies Pin,key);imported++;
          }catch(reason){error=reason;tx.abort();}
        };
      }
      tx.oncomplete=()=>resolve(imported);tx.onabort=()=>reject(error||tx.error||new Error('No se pudo guardar la continuidad de los contactos.'));tx.onerror=()=>reject(tx.error);
    });
  }

  private hasKnownEncryptionKeys(pin:Pin,fingerprint:DirectoryFingerprint):boolean{
    if(!pin.devices?.length||!fingerprint.deviceIdentities.length)return false;
    // Delivery encrypts to identityKey itself. An extra device using an exact
    // known public key exposes no new private-key holder. A replaced known
    // device, or any previously unseen encryption key, still fails closed.
    return fingerprint.deviceIdentities.every(device=>{
      const known=pin.devices!.find(candidate=>candidate.deviceId===device.deviceId);
      return known?known.identity===device.identity:pin.devices!.some(candidate=>candidate.identity===device.identity);
    });
  }
  private validId(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=128&&value.trim()===value;}
  private validEntry(value:IdentityTrustTransferEntry):boolean{
    return this.validId(value?.userId)&&typeof value.digest==='string'&&DIGEST.test(value.digest)&&typeof value.verified==='boolean'
      &&(!value.verified||typeof value.verifiedAt==='string')
      &&(value.devices===undefined||Array.isArray(value.devices)&&value.devices.length>0&&value.devices.length<=128
        &&new Set(value.devices.map(device=>device?.deviceId)).size===value.devices.length
        &&value.devices.every(device=>this.validId(device?.deviceId)&&typeof device.identity==='string'&&/^[A-Za-z0-9_-]{43}:[A-Za-z0-9_-]{43}$/.test(device.identity)))
      &&(value.verifiedAt===undefined||typeof value.verifiedAt==='string'&&/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value.verifiedAt)&&value.verifiedAt.length<=32&&Number.isFinite(Date.parse(value.verifiedAt))&&Date.parse(value.verifiedAt)<=Date.now()+60_000);
  }
  private clearChanged(scope:string,userId:string):void{
    this.changed.update(previous=>{const next=new Set(previous);next.delete(JSON.stringify([scope,userId]));return next;});
  }
  private async update(scope:string,userId:string,change:(pin:Pin|undefined)=>Pin):Promise<void>{
    const db=await this.open();
    await new Promise<void>((resolve,reject)=>{
      const tx=db.transaction('pins','readwrite');const store=tx.objectStore('pins');
      const key=JSON.stringify([scope,userId]);const request=store.get(key);let error:unknown;
      request.onsuccess=()=>{try{store.put(change(request.result),key);}catch(reason){error=reason;tx.abort();}};
      tx.oncomplete=()=>resolve();tx.onabort=()=>reject(error || tx.error || new Error('No se pudo guardar la verificación.'));tx.onerror=()=>reject(tx.error);
    });
  }
}
