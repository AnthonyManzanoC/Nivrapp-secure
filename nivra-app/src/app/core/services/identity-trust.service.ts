import { Injectable, signal } from '@angular/core';
import { PublicKeyDirectory } from '../models/nivra.models';
import { deriveDirectoryFingerprint } from '../utils/identity-fingerprint';

interface Pin { digest: string; verified: boolean; }
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
  async confirm(scope:string,directory:PublicKeyDirectory):Promise<void>{
    const fingerprint=await deriveDirectoryFingerprint(directory);
    await this.update(scope,directory.userId,()=>({digest:fingerprint.digest,verified:true}));
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
