import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { auditTime, filter, firstValueFrom, fromEvent, map, merge } from 'rxjs';
import { AuthService } from './auth.service';
import { ChatService } from './chat.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

export interface CommunityGroup { id:string; name:string; photo:string|null; memberCount:number; joined:boolean; requestPending?:boolean; canReview?:boolean; canRequest?:boolean; }
export interface Community { id:string; name:string; description:string; photo:string|null; role:string; memberCount:number; updatedAt:string; groups:CommunityGroup[]; }
export interface CommunityJoinRequest { groupId: string; userId: string; name: string; requestedAt: string; }
interface JoinResult { conversationId?: string; pending?: boolean; }

interface DirectoryRead { scope: string; dirty: boolean; done: Promise<void>; }

@Injectable({providedIn:'root'})
export class CommunityService {
  private readonly api=inject(NivraApiService);
  private readonly auth=inject(AuthService);
  private readonly chat=inject(ChatService);
  private readonly realtime=inject(SignalrService);
  private readonly destroyRef=inject(DestroyRef);
  private readonly state=signal<{scope:string;items:Community[]}>({scope:'',items:[]});
  private directoryRead: DirectoryRead | null = null;
  private observedScope='';
  private readonly intents=new Map<string,{signature:string;requestId:string}>();
  readonly loading=signal(false);
  readonly busy=signal('');
  readonly error=signal('');
  readonly items=computed(()=>this.state().scope===this.scope()?this.state().items:[]);
  private scope():string {const s=this.auth.session();return JSON.stringify([s?.user.id,s?.device.id,this.auth.sessionGeneration?.()??0]);}
  constructor(){
    effect(()=>{this.auth.session();this.auth.sessionGeneration?.();untracked(()=>{
      const scope=this.scope();if(scope===this.observedScope)return;this.observedScope=scope;
      this.directoryRead=null;this.state.set({scope,items:[]});this.busy.set('');this.error.set('');this.loading.set(false);this.intents.clear();
      if(this.auth.session())void this.load();
    });});
    const directoryEvents = this.realtime.events$.pipe(filter(({type,payload}) => {
      if (type === 'community.changed' || type === 'connected' || type === 'reconnected') return true;
      if (type !== 'conversation.created' && type !== 'conversation.updated' && type !== 'conversation.removed') return false;
      const conversation = payload as {id?: string; conversationId?: string} | null;
      const id = conversation?.id ?? conversation?.conversationId;
      return !!id && this.items().some(item => item.id === id || item.groups.some(group => group.id === id));
    }));
    merge(directoryEvents, fromEvent(window, 'online')).pipe(
      map(() => this.scope()),
      auditTime(200),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(scope => {
      if (scope === this.scope()) void this.load(true);
    });
  }

  load(invalidate = false): Promise<void> {
    if (!this.auth.session() || this.destroyRef.destroyed) return Promise.resolve();
    const scope = this.scope();
    const pending = this.directoryRead;
    if (pending?.scope === scope) {
      if (invalidate) pending.dirty = true;
      return pending.done;
    }
    const read: DirectoryRead = {scope, dirty: false, done: Promise.resolve()};
    this.directoryRead = read;
    this.loading.set(true);
    read.done = this.readDirectory(read);
    return read.done;
  }

  private async readDirectory(read: DirectoryRead): Promise<void> {
    const current = () => this.directoryRead === read && this.scope() === read.scope && !this.destroyRef.destroyed;
    try {
      do {
        read.dirty = false;
        try {
          const items = await firstValueFrom(this.api.get<Community[]>('/communities'));
          if (current() && !read.dirty) {
            this.state.set({scope: read.scope, items});
            this.error.set('');
          }
        } catch (error) {
          if (current() && !read.dirty) this.error.set(this.message(error));
        }
      } while (current() && read.dirty);
    } finally {
      if (current()) {
        this.directoryRead = null;
        this.loading.set(false);
      }
    }
  }
  create(value:{name:string;description:string;photo:string|null;groupIds:string[]}):Promise<Community|null>{return this.createOnce('create',value,requestId=>firstValueFrom(this.api.post<Community>('/communities',{...value,requestId})));}
  update(id:string,value:{name:string;description:string;photo:string|null}):Promise<Community|null>{return this.mutate('edit:'+id,()=>firstValueFrom(this.api.patch<Community>(`/communities/${encodeURIComponent(id)}`,value)));}
  async leave(id:string):Promise<boolean>{const scope=this.scope();const done=!!await this.mutate('leave:'+id,async()=>{await firstValueFrom(this.api.post(`/communities/${encodeURIComponent(id)}/leave`,{}));return true;});
    if(done&&scope===this.scope())this.state.update(s=>({...s,items:s.items.filter(c=>c.id!==id)}));return done;
  }
  link(id:string,conversationId:string):Promise<Community|null>{return this.mutate('link:'+id,()=>firstValueFrom(this.api.post<Community>(`/communities/${encodeURIComponent(id)}/groups`,{conversationId})));}
  async unlink(id:string,groupId:string):Promise<void>{await this.mutate('unlink:'+groupId,async()=>{await firstValueFrom(this.api.delete(`/communities/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupId)}`));return null;});}
  requestJoin(id: string, groupId: string): Promise<JoinResult | null> {
    const scope = this.scope();
    return this.mutate('join:'+groupId, async () => {
      const result = await firstValueFrom(this.api.post<JoinResult>(`/communities/${encodeURIComponent(id)}/groups/${encodeURIComponent(groupId)}/request`, {}));
      if (result.pending && scope === this.scope() && !this.destroyRef.destroyed) {
        this.state.update(state => state.scope !== scope ? state : {...state, items: state.items.map(item => item.id !== id
          ? item : {...item, groups: item.groups.map(group => group.id === groupId ? {...group, requestPending: true} : group)})});
      }
      return result;
    }, true);
  }
  joinRequests(id: string) {
    return this.api.get<CommunityJoinRequest[]>(`/communities/${encodeURIComponent(id)}/join-requests`);
  }
  reviewJoinRequest(id: string, request: CommunityJoinRequest, accept: boolean): Promise<boolean | null> {
    return this.mutate('review:'+request.groupId+':'+request.userId, async () => {
      await firstValueFrom(this.api.post(`/communities/${encodeURIComponent(id)}/groups/${encodeURIComponent(request.groupId)}/requests/${encodeURIComponent(request.userId)}`, {accept}));
      return true;
    }, true);
  }
  createGroup(id:string,name:string,participantUserIds:string[]):Promise<Community|null>{return this.createOnce('group:'+id,{name,participantUserIds},requestId=>firstValueFrom(this.api.post<Community>(`/communities/${encodeURIComponent(id)}/groups/create`,{name,participantUserIds,requestId})));}
  async inviteLink(id:string):Promise<string|null>{
    const response=await this.mutate('invite:'+id,()=>firstValueFrom(this.api.post<{code:string}>(`/conversations/${encodeURIComponent(id)}/invite-links`,{})));
    return response ? `https://nivrapp-secure.vercel.app/group/invite#${encodeURIComponent(response.code)}` : null;
  }
  private async mutate<T>(key:string,action:()=>Promise<T>,directoryOnly=false):Promise<T|null>{
    if(this.busy())return null;
    const scope=this.scope();this.busy.set(key);this.error.set('');
    try {const result=await action();if(scope!==this.scope()||this.destroyRef.destroyed)return null;
      const refresh = () => Promise.allSettled([this.load(true),this.chat.refreshChats()]);
      if(result&&typeof result==='object'&&'groups' in result&&'id' in result){
        const community=result as unknown as Community;
        this.state.update(s=>({scope,items:[community,...(s.scope===scope?s.items:[]).filter(c=>c.id!==community.id)]}));
        // The server already committed the change. Keep the form responsive on a weak connection.
        void refresh();
      } else if (directoryOnly) {
        void this.load(true);
      } else {
        await refresh();
      }
      return scope===this.scope()&&!this.destroyRef.destroyed?result:null;
    }catch(error){if(scope===this.scope())this.error.set(this.message(error));return null;}
    finally{if(scope===this.scope())this.busy.set('');}
  }
  private async createOnce(key:string,value:unknown,action:(requestId:string)=>Promise<Community>):Promise<Community|null>{
    if(this.busy())return null;
    const scope=this.scope(),signature=JSON.stringify(value);
    const prior=this.intents.get(key);
    const intent=prior?.signature===signature?prior:{signature,requestId:crypto.randomUUID()};
    this.intents.set(key,intent);
    const result=await this.mutate(key,()=>action(intent.requestId));
    if(result&&scope===this.scope()&&this.intents.get(key)===intent)this.intents.delete(key);
    return result;
  }
  private message(error:unknown):string{return (error as {error?:{message?:string}})?.error?.message || 'No se pudo actualizar la comunidad. Comprueba la conexión y vuelve a intentarlo.';}
}
