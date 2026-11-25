import { Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ChatMessageVm, ChatPayload } from '../models/nivra.models';
import { AccountHistoryEnvelope, AccountHistoryUnsupportedMessage } from '../utils/account-history-sync';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { AccountIdentityService } from './account-identity.service';
import { HistoryArchiveService } from './history-archive.service';
import { LocalHistoryService } from './local-history.service';
import { NetworkPolicyService } from './network-policy.service';
import { NivraApiService } from './nivra-api.service';

interface HistoryPage { messages: AccountHistoryEnvelope[]; next: string; hasMore: boolean; }
interface Scan { account: string; conversation: string; before?: string; beforeId?: string; complete: boolean; }
interface SyncOwner { userId: string; deviceId: string; assert: () => void; }
const PAGE_SIZE = 8;
const MAX_PAGES_PER_TURN = 3;
const MINUTE = 60_000;
const validCursor = (value: unknown): value is string => typeof value === 'string'
  && /^(?:0|[1-9]\d{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
/** Background root-backed history. Device authority is a routing preference, never an encryption privilege. */
@Injectable({ providedIn: 'root' })
export class AccountHistorySyncService implements OnDestroy {
  private readonly auth=inject(AuthService);
  private readonly lock=inject(AppLockService);
  private readonly identity=inject(AccountIdentityService);
  private readonly archive=inject(HistoryArchiveService);
  private readonly history=inject(LocalHistoryService);
  private readonly api=inject(NivraApiService);
  private readonly network=inject(NetworkPolicyService);
  readonly state=signal<'idle'|'syncing'|'ready'|'unavailable'>('idle');
  private running: { scope: string } | null = null;
  private destroyed=false;
  private scope='';
  private scans:Scan[]=[];
  private scanPrepared=false;
  private scanAt=0;
  private uploaded=new Set<string>();
  private queued=new Map<string,ChatMessageVm>();
  private retryAt=0;
  private nextRestoreAt = 0;
  private restoreComplete = false;
  private readonly subscription=this.history.messagesStored$.subscribe(event=>{
    const session=this.auth.session();
    if(!session||this.lock.isContentLocked()||!(event.accountKey===session.user.id||event.accountKey.startsWith(session.user.id+':')))return;
    this.syncScope();
    for(const message of event.messages){const normalized=this.normalized(message);if(normalized&&!this.uploaded.has(normalized.id))this.queued.set(normalized.id,normalized);}
    while(this.queued.size>256){
      const oldest=this.queued.keys().next().value!;
      const evicted=this.queued.get(oldest)!;
      this.queued.delete(oldest);
      // These rows are already stored locally. Revisit only their
      // conversation so a full pending queue cannot lose archive work.
      this.scanPrepared=false;
      for(const scan of this.scans){
        if(scan.conversation!==evicted.conversationId)continue;
        scan.before=undefined;
        scan.beforeId=undefined;
        scan.complete=false;
      }
    }
    if(this.queued.size)void this.pump().catch(()=>undefined);
  });
  private readonly timer=window.setInterval(()=>{void this.pump().catch(()=>undefined);},15000);
  private readonly wake = () => {
    if (document.visibilityState === 'hidden') return;
    // A resumed app can see new history promptly, while duplicate visibility
    // and online events cannot turn a single resume into repeated requests.
    if (this.restoreComplete && this.nextRestoreAt - Date.now() <= MINUTE - 15_000) this.nextRestoreAt = 0;
    void this.pump();
  };

  constructor() {
    window.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
    effect(() => {
      const scope = this.currentScope();
      const ready = this.identity.state();
      untracked(() => {
        this.syncScope(scope);
        if (ready === 'ready' || ready === 'password') void this.pump();
      });
    });
  }
  ngOnDestroy():void{
    this.destroyed=true;
    window.clearInterval(this.timer);
    window.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    this.subscription.unsubscribe();
  }
  private currentScope(): string {
    const session = this.auth.session();
    return JSON.stringify([session?.user.id, session?.device.id, this.auth.sessionGeneration(), this.lock.isContentLocked(), this.lock.lockCycle?.()]);
  }
  private syncScope(scope = this.currentScope()): string {
    if (scope !== this.scope) {
      this.scope = scope;
      this.scans = [];
      this.scanPrepared = false;
      this.scanAt = 0;
      this.uploaded.clear();
      this.queued.clear();
      this.retryAt = 0;
      this.nextRestoreAt = 0;
      this.restoreComplete = false;
      this.state.set('idle');
    }
    return scope;
  }
  private owner(): SyncOwner {
    const session=this.auth.session();if(this.destroyed||!session||this.lock.isContentLocked())throw Error('La cuenta está bloqueada.');
    const scope = this.currentScope(), userId = session.user.id, deviceId = session.device.id;
    const assert=()=>{if(this.destroyed||scope!==this.currentScope())throw Error('La cuenta cambió durante la sincronización.');};
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
    if(this.destroyed||!this.auth.session()||this.lock.isContentLocked()||document.visibilityState==='hidden'||navigator.onLine===false)return;
    const scope = this.syncScope();
    const now = Date.now();
    if (this.running?.scope === scope || now < this.retryAt) return;
    const restoreDue = now >= this.nextRestoreAt;
    const captureDue = this.queued.size > 0 || !this.scanPrepared
      || this.scans.some(scan => !scan.complete) || now > this.scanAt + 5 * MINUTE;
    if (!restoreDue && !captureDue) return;
    const operation = { scope };
    this.running = operation;
    try{
      const owner=this.owner(),root=await this.identity.historyRoot();owner.assert();if(!root)return;
      if(!navigator.locks)throw Error('El almacenamiento necesita exclusión entre pestañas.');
      await navigator.locks.request(`nivra-account-history:${owner.userId}:${owner.deviceId}`,{ifAvailable:true},async lease=>{
        owner.assert();if(!lease)return;
        this.state.set('syncing');
        if (restoreDue) {
          const restored = await this.restore(root, owner); owner.assert();
          this.restoreComplete = restored;
          this.nextRestoreAt = Date.now() + (restored ? MINUTE : 20_000);
        }
        if (captureDue) await this.capture(owner);
        owner.assert();
        this.state.set(this.restoreComplete&&this.scans.every(scan=>scan.complete)&&this.queued.size===0?'ready':'syncing');
      });
    }catch(error){
      // Older API versions and offline dependencies keep P2P/history recovery intact; never declare success.
      if(!this.destroyed&&scope===this.currentScope()&&this.auth.session()&&!this.lock.isContentLocked()){
        const status=(error as {status?:number})?.status;
        this.state.set('unavailable');this.retryAt=Date.now()+(status===404||status===429?MINUTE:15000);
      }
    }finally{if(this.running===operation)this.running=null;}
  }
  private remember(id:string):void{
    this.uploaded.add(id);this.queued.delete(id);
    while(this.uploaded.size>10000)this.uploaded.delete(this.uploaded.keys().next().value!);
  }
  private async restore(root:string, owner = this.owner()):Promise<boolean>{
    const key='account-history-sync:'+owner.deviceId;
    let saved=await this.history.readRatchetState(owner.userId,key);owner.assert();
    const checkpoint=saved?.state as {v?:number;root?:string;cursor?:string}|undefined;
    let cursor=checkpoint?.v===1&&checkpoint.root===root&&validCursor(checkpoint.cursor)?checkpoint.cursor:'0';
    for(let turn=0;turn<MAX_PAGES_PER_TURN;turn++){
      const page=await firstValueFrom(this.api.get<HistoryPage>('/account/history-sync?after='+encodeURIComponent(cursor)).pipe(timeout(this.network.readTimeoutMs())));owner.assert();
      if(!page||!Array.isArray(page.messages)||page.messages.length>PAGE_SIZE||!validCursor(page.next)||BigInt(page.next)<BigInt(cursor)
        ||typeof page.hasMore!=='boolean'||(page.hasMore||page.messages.length>0)&&page.next===cursor
        ||new Set(page.messages.map(row=>row?.messageId)).size!==page.messages.length)throw Error('Página de historial inválida.');
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
  private async capture(owner = this.owner()):Promise<void>{
    if(this.scanPrepared&&Date.now()>this.scanAt+5*MINUTE&&this.scans.every(scan=>scan.complete))this.scanPrepared=false;
    if(!this.scanPrepared){
      const accounts=[...new Set([owner.userId,...await this.history.accountKeysForUser(owner.userId)])].filter(key=>key===owner.userId||key.startsWith(owner.userId+':'));owner.assert();
      const scans:Scan[]=[];
      const previous=new Map(this.scans.map(scan=>[JSON.stringify([scan.account,scan.conversation]),scan]));
      for(const account of accounts){
        const conversations=await this.history.conversations(account);owner.assert();
        for(const conversation of conversations){
          if(!/^[a-zA-Z0-9_-]{1,128}$/.test(conversation.id))continue;
          scans.push(previous.get(JSON.stringify([account,conversation.id]))??{account,conversation:conversation.id,complete:false});
        }
      }
      this.scans=scans;this.scanPrepared=true;this.scanAt=Date.now();
    }
    for(let turn=0;turn<MAX_PAGES_PER_TURN;turn++){
      let messages=[...this.queued.values()].filter(message=>!this.uploaded.has(message.id)).slice(0,PAGE_SIZE);
      if(!messages.length){
        const scan=this.scans.find(value=>!value.complete);if(!scan)return;
        const options={limit:PAGE_SIZE,before:scan.before,beforeId:scan.beforeId};
        const [primary,deliveries]=await Promise.all([this.history.conversationMessagesPage(scan.account,scan.conversation,options),this.history.conversationMessagesPage(scan.account,'ratchet-receipt:'+scan.conversation,options)]);owner.assert();
        const byId=new Map<string,ChatMessageVm>();
        for(const message of [...deliveries,...primary])if(!message.decryptError||!byId.has(message.id))byId.set(message.id,message);
        const all=[...byId.values()].sort((a,b)=>(a.at<b.at?-1:a.at>b.at?1:0)||(a.id<b.id?-1:a.id>b.id?1:0)).slice(-PAGE_SIZE);
        if(!all.length){scan.complete=true;continue;}
        const first=all[0];scan.before=first.at;scan.beforeId=first.id;
        messages=all.map(message=>this.normalized(message)).filter((message):message is ChatMessageVm=>!!message&&!this.uploaded.has(message.id));
      }
      if(!messages.length)continue;
      for(const message of messages)this.queued.set(message.id,message);
      const envelopes:AccountHistoryEnvelope[]=[];
      for(const message of messages){
        try{envelopes.push(await this.identity.sealHistory(message));owner.assert();}
        catch(error){
          owner.assert();
          if(!(error instanceof AccountHistoryUnsupportedMessage))throw error;
          this.queued.delete(message.id);
        }
      }
      if(!envelopes.length)continue;
      const response=await firstValueFrom(this.api.post<{accepted:string[]}>('/account/history-sync',{messages:envelopes}).pipe(timeout(this.network.readTimeoutMs())));owner.assert();
      if(!response||!Array.isArray(response.accepted)||response.accepted.some(id=>!envelopes.some(envelope=>envelope.messageId===id)))throw Error('Confirmación de historial inválida.');
      for(const envelope of envelopes)this.queued.delete(envelope.messageId);
      for(const id of response.accepted)this.remember(id);
    }
  }
}
