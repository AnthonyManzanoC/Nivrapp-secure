import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';
import { AccountDeviceCertificate, AccountIdentityBackup, AccountIdentitySecret, accountBackupStatement, accountDeviceStatement, accountRecoveryPhrase, accountRootStatement, createAccountIdentity, identityBytes, openAccountBackup, sealAccountBackup, signAccountIdentity, verifyAccountIdentity } from '../utils/account-identity';

export interface AccountIdentityContext { hybridIdentity: string; legacyIdentity: string; endorse: (bytes: Uint8Array<ArrayBuffer>) => Promise<string>; }
export interface AccountIdentityTransfer { v: 1; secret: AccountIdentitySecret; backup: AccountIdentityBackup; }
interface LocalIdentity { v: 1; secret: AccountIdentitySecret; backup: AccountIdentityBackup; }

@Injectable({providedIn:'root'})
export class AccountIdentityService {
  private readonly auth=inject(AuthService);
  private readonly appLock=inject(AppLockService);
  private readonly api=inject(NivraApiService);
  private readonly history=inject(LocalHistoryService);
  private cache:{scope:string;local:LocalIdentity;revision:number}|null=null;
  private certified='';
  private readonly status=signal({scope:'',state:'password' as 'ready'|'password'|'recovery'|'unavailable',error:''});
  readonly state=computed(()=>this.status().scope===this.scope()?this.status().state:'password');
  readonly error=computed(()=>this.status().scope===this.scope()?this.status().error:'');
  constructor(){effect(()=>{const scope=this.scope(),locked=this.appLock.isContentLocked();untracked(()=>{if(locked||this.cache?.scope!==scope){this.cache=null;this.certified='';}});});}
  private scope():string{const s=this.auth.session();return JSON.stringify([s?.user.id,s?.device.id,this.auth.sessionGeneration()]);}
  private owner(){const session=this.auth.session(),scope=this.scope();if(!session||this.appLock.isContentLocked())throw Error('Desbloquea Nivra para recuperar tu identidad.');
    const check=()=>{if(scope!==this.scope()||this.appLock.isContentLocked())throw Error('La cuenta cambió durante la recuperación.');};return {scope,userId:session.user.id,deviceId:session.device.id,alias:session.user.alias,check};}
  private storageId(deviceId:string):string{return 'account-identity:'+deviceId;}
  private async local():Promise<LocalIdentity|null>{
    const owner=this.owner();if(this.cache?.scope===owner.scope)return this.cache.local;
    const saved=await this.history.readRatchetState(owner.userId,this.storageId(owner.deviceId));owner.check();
    if(!saved)return null;const local=saved.state as LocalIdentity;
    if(local?.v!==1||local.secret?.userId!==owner.userId||local.secret.rootKey!==local.backup?.identity?.rootKey)throw Error('La identidad local necesita recuperarse con tu contraseña o frase.');
    this.cache={scope:owner.scope,local,revision:saved.revision};this.status.set({scope:owner.scope,state:'ready',error:''});return local;
  }
  private async save(local:LocalIdentity):Promise<void>{
    const owner=this.owner();const saved=await this.history.readRatchetState(owner.userId,this.storageId(owner.deviceId));owner.check();
    // CAS prevents two tabs from replacing an established secret with competing roots.
    if(saved){const prior=saved.state as LocalIdentity;if(prior.secret?.rootKey!==local.secret.rootKey)throw Error('Este equipo ya conserva otra identidad. Se ha mantenido intacta.');}
    const revision=await this.history.commitRatchetState(owner.userId,this.storageId(owner.deviceId),saved?.revision??0,local);owner.check();
    this.cache={scope:owner.scope,local,revision};this.certified='';this.status.set({scope:owner.scope,state:'ready',error:''});
  }
  private remote():Promise<AccountIdentityBackup|null>{return firstValueFrom(this.api.get<AccountIdentityBackup|null>('/account/identity').pipe(timeout(20000)));}
  private async upload(secret:AccountIdentitySecret,backup:AccountIdentityBackup):Promise<AccountIdentityBackup>{
    const signature=await signAccountIdentity(secret,accountBackupStatement(secret.userId,backup));
    return firstValueFrom(this.api.post<AccountIdentityBackup>('/account/identity',{...backup,signature}).pipe(timeout(20000)));
  }
  async activate(password:string,context:AccountIdentityContext,recoveryPhrase?:string):Promise<void>{
    const owner=this.owner();
    try{
      let backup=await this.remote();owner.check();
      let secret:AccountIdentitySecret;
      if(backup){
        const retained=await this.local();owner.check();
        if(recoveryPhrase)secret=await openAccountBackup(owner.userId,backup.identity.rootKey,backup.recoveryBackup,recoveryPhrase,'recovery');
        else if(retained?.secret.rootKey===backup.identity.rootKey)secret=retained.secret;
        else secret=await openAccountBackup(owner.userId,backup.identity.rootKey,backup.passwordBackup,password,'password');
        owner.check();
        // Rewrap after a verified password change, keeping the established root and phrase.
        try{await openAccountBackup(owner.userId,backup.identity.rootKey,backup.passwordBackup,password,'password');}
        catch{backup={...backup,passwordBackup:await sealAccountBackup(secret,password,'password')};owner.check();backup=await this.upload(secret,backup);}
      }else{
        if(recoveryPhrase)throw Error('Esta cuenta aún no tiene una copia de identidad que recuperar.');
        secret=await createAccountIdentity(owner.userId);owner.check();
        const root={v:1 as const,rootKey:secret.rootKey,sourceDeviceId:owner.deviceId,sourceHybrid:context.hybridIdentity,sourceLegacy:context.legacyIdentity};
        const identity={...root,endorsement:await context.endorse(accountRootStatement(owner.userId,root))};owner.check();
        backup={identity,passwordBackup:await sealAccountBackup(secret,password,'password'),recoveryBackup:await sealAccountBackup(secret,'','recovery'),revision:0};owner.check();
        try{backup=await this.upload(secret,backup);}
        catch(error){
          if((error as {status?:number})?.status!==409)throw error;
          // First-login race: adopt the committed root, never overwrite it.
          backup=await this.remote();owner.check();if(!backup)throw error;
          secret=await openAccountBackup(owner.userId,backup.identity.rootKey,backup.passwordBackup,password,'password');
        }
      }
      owner.check();await this.save({v:1,secret,backup});owner.check();await this.certify(context);
    }catch(error){if(owner.scope===this.scope())this.status.set({scope:owner.scope,state:'recovery',error:'No se pudo recuperar la identidad. Usa tu frase de respaldo o un dispositivo que conserve las llaves.'});throw error;}
  }
  async verifyPassword(password:string):Promise<void>{const owner=this.owner();const resolved=await firstValueFrom(this.api.post<{userId:string}>('/auth/login',{alias:'@'+owner.alias,password,deviceName:'Identity recovery',keyBundle:null,resolveOnly:true},{skipAuth:true}).pipe(timeout(20000)));owner.check();if(resolved.userId!==owner.userId)throw Error('La contraseña no corresponde a esta cuenta.');}
  async certify(context:AccountIdentityContext):Promise<void>{
    const owner=this.owner(),local=await this.local();owner.check();if(!local)return;
    const mark=JSON.stringify([owner.scope,local.secret.rootKey,context.hybridIdentity,context.legacyIdentity]);if(this.certified===mark)return;
    const certificate:AccountDeviceCertificate={v:1,rootKey:local.secret.rootKey,deviceId:owner.deviceId,legacyKey:context.legacyIdentity,hybridKey:context.hybridIdentity,signature:''};
    certificate.signature=await signAccountIdentity(local.secret,accountDeviceStatement(owner.userId,certificate));owner.check();
    await firstValueFrom(this.api.post('/account/identity/device',certificate).pipe(timeout(15000)));owner.check();this.certified=mark;
  }
  async phrase():Promise<string>{const local=await this.local();if(!local)throw Error('Activa primero la recuperación de identidad.');return accountRecoveryPhrase(local.secret);}
  async exportForDevice():Promise<AccountIdentityTransfer|undefined>{const local=await this.local();return local?{v:1,secret:local.secret,backup:local.backup}:undefined;}
  async importForDevice(transfer:AccountIdentityTransfer):Promise<void>{
    const owner=this.owner();if(transfer?.v!==1||JSON.stringify(transfer).length>40000||transfer.secret?.userId!==owner.userId)throw Error('La identidad transferida no corresponde a esta cuenta.');
    const backup=await this.remote();owner.check();if(!backup||JSON.stringify(backup.identity)!==JSON.stringify(transfer.backup.identity)||backup.identity.rootKey!==transfer.secret.rootKey)throw Error('La identidad transferida ya no coincide con la cuenta.');
    const challenge=identityBytes(['nivra-account-import',owner.userId,owner.deviceId]);
    if(!await verifyAccountIdentity(backup.identity.rootKey,challenge,await signAccountIdentity(transfer.secret,challenge)))throw Error('La identidad transferida no es válida.');owner.check();
    await this.save({v:1,secret:transfer.secret,backup});
  }
}
