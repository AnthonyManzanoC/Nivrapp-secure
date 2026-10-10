import { Injectable, signal } from '@angular/core';
import { PublicKeyDirectory } from '../models/nivra.models';
import { deriveDirectoryFingerprint } from '../utils/identity-fingerprint';

interface Pin { digest: string; verified: boolean; verifiedAt?: string; }
export interface IdentityContinuity {
  state: 'unknown' | 'unchanged' | 'verified' | 'changed';
  verifiedAt?: string;
}
@Injectable({providedIn:'root'})
export class IdentityTrustService {
  private readonly changed = signal<ReadonlySet<string>>(new Set());
  isChanged(scope:string,userId:string):boolean { return this.changed().has(JSON.stringify([scope,userId])); }
  private database?: Promise<IDBDatabase>;
  private open():Promise<IDBDatabase>{
    return this.database ??= new Promise((resolve,reject)=>{
      const request=indexedDB.open('nivra-identity-trust',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('pins');
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
  }
  async check(scope:string,directory:PublicKeyDirectory):Promise<void>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    await this.update(scope,directory.userId,current=>{
      if(current && current.digest!==fingerprint.digest) {
        this.changed.update(previous=>new Set([...previous,JSON.stringify([scope,directory.userId])]));
        throw new Error('La identidad de este contacto ha cambiado. Abre Verificar identidad y compara el código antes de continuar.');
      }
      return current || {digest:fingerprint.digest,verified:false};
    });
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
    if(pin.digest!==fingerprint.digest)return {state:'changed'};
    return {state:pin.verified?'verified':'unchanged',...(pin.verifiedAt?{verifiedAt:pin.verifiedAt}:{})};
  }
  async confirm(scope:string,directory:PublicKeyDirectory,isCurrent:()=>boolean=()=>true):Promise<void>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    if(!isCurrent())throw new Error('La comparación ya no está activa.');
    await this.update(scope,directory.userId,()=>{
      if(!isCurrent())throw new Error('La comparación ya no está activa.');
      return {digest:fingerprint.digest,verified:true,verifiedAt:new Date().toISOString()};
    });
    this.changed.update(previous=>{const next=new Set(previous);next.delete(JSON.stringify([scope,directory.userId]));return next;});
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
