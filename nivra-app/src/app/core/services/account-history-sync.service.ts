import { Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ChatMessageVm, ChatPayload } from '../models/nivra.models';
import { AccountHistoryEnvelope } from '../utils/account-history-sync';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { AccountIdentityService } from './account-identity.service';
import { HistoryArchiveService } from './history-archive.service';
import { LocalHistoryService } from './local-history.service';
import { NivraApiService } from './nivra-api.service';

interface HistoryPage { messages: AccountHistoryEnvelope[]; next: string; hasMore: boolean; }
interface Scan { account: string; conversation: string; before?: string; beforeId?: string; complete: boolean; }
/** Background root-backed history. Device authority is a routing preference, never an encryption privilege. */
@Injectable({ providedIn: 'root' })
export class AccountHistorySyncService implements OnDestroy {
  private readonly auth=inject(AuthService);
  private readonly lock=inject(AppLockService);
  private readonly identity=inject(AccountIdentityService);
  private readonly archive=inject(HistoryArchiveService);
  private readonly history=inject(LocalHistoryService);
  private readonly api=inject(NivraApiService);
  readonly state=signal<'idle'|'syncing'|'ready'|'unavailable'>('idle');
  private running=false;
  private destroyed=false;
  private scope='';
  private scans:Scan[]=[];
  private scanPrepared=false;
  private scanAt=0;
  private uploaded=new Set<string>();
  private queued=new Map<string,ChatMessageVm>();
  private retryAt=0;
  private readonly subscription=this.history.messagesStored$.subscribe(event=>{
    const session=this.auth.session();
    if(!session||this.lock.isContentLocked()||!(event.accountKey===session.user.id||event.accountKey.startsWith(session.user.id+':')))return;
    for(const message of event.messages){const normalized=this.normalized(message);if(normalized&&!this.uploaded.has(normalized.id))this.queued.set(normalized.id,normalized);}
    while(this.queued.size>256)this.queued.delete(this.queued.keys().next().value!);
    if(this.queued.size)void this.pump().catch(()=>undefined);
  });
  private readonly timer=window.setInterval(()=>{void this.pump().catch(()=>undefined);},15000);
  constructor(){effect(()=>{
    const session=this.auth.session(),generation=this.auth.sessionGeneration(),locked=this.lock.isContentLocked(),ready=this.identity.state();
    const scope=JSON.stringify([session?.user.id,session?.device.id,generation]);
    untracked(()=>{
      if(locked||scope!==this.scope){this.scope=scope;this.scans=[];this.scanPrepared=false;this.scanAt=0;this.uploaded.clear();this.queued.clear();this.retryAt=0;this.state.set('idle');}
      if(session&&!locked&&(ready==='ready'||ready==='password'))void this.pump().catch(()=>undefined);
    });
  });}
  ngOnDestroy():void{this.destroyed=true;window.clearInterval(this.timer);this.subscription.unsubscribe();}
  private owner(){
    const session=this.auth.session();if(this.destroyed||!session||this.lock.isContentLocked())throw Error('La cuenta está bloqueada.');
    const generation=this.auth.sessionGeneration(),userId=session.user.id,deviceId=session.device.id;
    const assert=()=>{const now=this.auth.session();if(this.destroyed||this.lock.isContentLocked()||generation!==this.auth.sessionGeneration()||now?.user.id!==userId||now.device.id!==deviceId)throw Error('La cuenta cambió durante la sincronización.');};
    return{userId,deviceId,assert};
  }
  private normalized(message:ChatMessageVm):ChatMessageVm|null{
    const delivery=['ratchet-delivery','ratchet-archive-delivery'].includes(message.payload?.type);
    const candidate=delivery?{...message,conversationId:message.conversationId.replace(/^ratchet-receipt:/,''),payload:message.payload['content'] as ChatPayload}:message;
    if(!candidate||candidate.status==='sending'||/^local[-_]/.test(candidate.id)||candidate.payload?.['__nivraOutbox']!==undefined||candidate.decryptError||candidate.deleteAfterRead||!candidate.payload||typeof candidate.payload!=='object'||typeof candidate.payload.type!=='string'||candidate.payload.type==='view-once-opened'||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(candidate.id)||!candidate.senderDeviceId||candidate.conversationId.includes(':')||candidate.expiresAt&&Date.parse(candidate.expiresAt)<=Date.now())return null;
    return candidate;
  }
  async pump():Promise<void>{
    if(this.destroyed||this.running||!this.auth.session()||this.lock.isContentLocked()||document.visibilityState==='hidden'||navigator.onLine===false||Date.now()<this.retryAt)return;
    const operationScope=this.scope;
    this.running=true;
    try{
      const owner=this.owner(),root=await this.identity.historyRoot();owner.assert();if(!root)return;
      if(!navigator.locks)throw Error('El almacenamiento necesita exclusión entre pestañas.');
      await navigator.locks.request(`nivra-account-history:${owner.userId}:${owner.deviceId}`,{ifAvailable:true},async lease=>{
        owner.assert();if(!lease)return;
        this.state.set('syncing');
        const restored=await this.restore(root);owner.assert();
        await this.capture();owner.assert();
        this.state.set(restored&&this.scans.every(scan=>scan.complete)&&this.queued.size===0?'ready':'syncing');
      });
    }catch(error){
      // Older API versions and offline dependencies keep P2P/history recovery intact; never declare success.
      if(!this.destroyed&&operationScope===this.scope&&this.auth.session()&&!this.lock.isContentLocked()){
        this.state.set('unavailable');this.retryAt=Date.now()+((error as {status?:number})?.status===404?60000:15000);
      }
    }finally{this.running=false;}
  }
  private remember(id:string):void{
    this.uploaded.add(id);this.queued.delete(id);
    while(this.uploaded.size>10000)this.uploaded.delete(this.uploaded.keys().next().value!);
  }
  private async restore(root:string):Promise<boolean>{
    const owner=this.owner(),key='account-history-sync:'+owner.deviceId;
    let saved=await this.history.readRatchetState(owner.userId,key);owner.assert();
    const checkpoint=saved?.state as {v?:number;root?:string;cursor?:string}|undefined;
    let cursor=checkpoint?.v===1&&checkpoint.root===root&&/^\d+$/.test(checkpoint.cursor??'')?checkpoint.cursor!:'0';
    for(let turn=0;turn<3;turn++){
      const page=await firstValueFrom(this.api.get<HistoryPage>('/account/history-sync?after='+encodeURIComponent(cursor)).pipe(timeout(20000)));owner.assert();
      if(!page||!Array.isArray(page.messages)||page.messages.length>8||typeof page.next!=='string'||!/^\d+$/.test(page.next)||BigInt(page.next)<BigInt(cursor)||page.hasMore&&page.next===cursor)throw Error('Página de historial inválida.');
      const messages:ChatMessageVm[]=[];
      for(const row of page.messages){messages.push(await this.identity.openHistory(row));owner.assert();}
      if(messages.length){await this.archive.importMessages(messages);owner.assert();for(const message of messages)this.remember(message.id);}
      if(page.next!==cursor){
        const revision=await this.history.commitRatchetState(owner.userId,key,saved?.revision??0,{v:1,root,cursor:page.next});owner.assert();
        saved={revision,state:{v:1,root,cursor:page.next}};cursor=page.next;
      }
      if(!page.hasMore)return true;
    }
    return false;
  }
  private async capture():Promise<void>{
    const owner=this.owner();
    if(this.scanPrepared&&Date.now()>this.scanAt+300000&&this.scans.every(scan=>scan.complete))this.scanPrepared=false;
    if(!this.scanPrepared){
      const accounts=[...new Set([owner.userId,...await this.history.accountKeysForUser(owner.userId)])].filter(key=>key===owner.userId||key.startsWith(owner.userId+':'));owner.assert();
      const scans:Scan[]=[];
      for(const account of accounts){
        const conversations=await this.history.conversations(account);owner.assert();
        for(const conversation of conversations)if(/^[a-zA-Z0-9_-]{1,128}$/.test(conversation.id))scans.push({account,conversation:conversation.id,complete:false});
      }
      this.scans=scans;this.scanPrepared=true;this.scanAt=Date.now();
    }
    for(let turn=0;turn<3;turn++){
      let messages=[...this.queued.values()].filter(message=>!this.uploaded.has(message.id)).slice(0,8);
      if(!messages.length){
        const scan=this.scans.find(value=>!value.complete);if(!scan)return;
        const options={limit:8,before:scan.before,beforeId:scan.beforeId};
        const [primary,deliveries]=await Promise.all([this.history.conversationMessagesPage(scan.account,scan.conversation,options),this.history.conversationMessagesPage(scan.account,'ratchet-receipt:'+scan.conversation,options)]);owner.assert();
        const byId=new Map<string,ChatMessageVm>();
        for(const message of [...deliveries,...primary])if(!message.decryptError||!byId.has(message.id))byId.set(message.id,message);
        const all=[...byId.values()].sort((a,b)=>(a.at<b.at?-1:a.at>b.at?1:0)||(a.id<b.id?-1:a.id>b.id?1:0)).slice(-8);
        if(!all.length){scan.complete=true;continue;}
        const first=all[0];scan.before=first.at;scan.beforeId=first.id;
        messages=all.map(message=>this.normalized(message)).filter((message):message is ChatMessageVm=>!!message&&!this.uploaded.has(message.id));
      }
      if(!messages.length)continue;
      for(const message of messages)this.queued.set(message.id,message);
      const envelopes:AccountHistoryEnvelope[]=[];
      for(const message of messages){
        try{envelopes.push(await this.identity.sealHistory(message));owner.assert();}
        catch(error){owner.assert();this.queued.delete(message.id);throw error;}
      }
      const response=await firstValueFrom(this.api.post<{accepted:string[]}>('/account/history-sync',{messages:envelopes}).pipe(timeout(20000)));owner.assert();
      if(!response||!Array.isArray(response.accepted)||response.accepted.some(id=>!messages.some(message=>message.id===id)))throw Error('Confirmación de historial inválida.');
      for(const message of messages)this.queued.delete(message.id);
      for(const id of response.accepted)this.remember(id);
    }
  }
}
