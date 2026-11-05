import { Component, DestroyRef, Input, OnChanges, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom, timeout } from 'rxjs';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { NativeDeviceService } from '../../core/services/native-device.service';
import { TransientNoticeDirective } from '../../shared/transient-notice.directive';
import { Contact, Conversation, UserSummary } from '../../core/models/nivra.models';

interface InviteTarget { id: string; title: string; photo: string; conversation?: Conversation; contact?: Contact; }

@Component({
  selector: 'app-group-invite-share', standalone: true, imports: [CommonModule, FormsModule, TransientNoticeDirective],
  template: `<section><h3>Invitar a {{community ? 'la comunidad' : 'este grupo'}}</h3><p>Válido por 24 horas y hasta 25 incorporaciones. Quien lo tenga puede unirse; puedes revocarlo.</p>
    <button type="button" [disabled]="busy" (click)="create()">Crear enlace</button>
    @if (validLink()) { <input aria-label="Enlace de invitación" readonly [value]="validLink()"><div class="actions"><button type="button" [disabled]="busy" (click)="copy()">Copiar enlace</button><button type="button" [disabled]="busy" (click)="shareOutside()">Compartir fuera de Nivra</button><button type="button" [disabled]="busy" (click)="pickerOpen=!pickerOpen">Enviar en Nivra</button></div>
      @if(pickerOpen){<div class="picker"><h4>Seleccionar contactos y chats</h4><input type="search" [(ngModel)]="query" [disabled]="busy" placeholder="Buscar un contacto o chat" aria-label="Buscar un contacto o chat"><div class="targets">@for(item of targets(); track item.id){<button type="button" class="target" [class.selected]="selected.has(item.id)" [attr.aria-pressed]="selected.has(item.id)" (click)="toggle(item.id)" [disabled]="busy">@if(item.photo){<img [src]="item.photo" alt="" loading="lazy">}@else{<span class="face">{{item.title.slice(0,2).toUpperCase()}}</span>}<strong>{{item.title}}</strong><span aria-hidden="true">{{selected.has(item.id)?'✓':'○'}}</span></button>}@empty{<p>No encontramos contactos.</p>}</div><button type="button" [disabled]="busy || !selected.size" (click)="send()">Enviar invitación · {{selected.size}}</button></div>} }
    <button type="button" [disabled]="busy" (click)="load()">Ver enlaces creados</button>
    @for (item of visibleLinks(); track item.id) {<div class="saved-link">{{item.expiresAt | date:'short'}} · {{item.uses}}/{{item.maxUses}} usos
      @if (!item.revokedAt) {<button type="button" [disabled]="busy" (click)="revoke(item.id)">Revocar</button>} @else {<span>Revocado</span>}</div>}
    @if(message){<p role="status" [appTransientNotice]="message" (noticeExpired)="message=''">{{message}}</p>}</section>`,
  styles: [`:host{display:block;min-width:0}section{padding:20px;border:1px solid var(--nivra-line);border-radius:22px;color:var(--nivra-text);background:var(--nivra-panel-solid)}h3,h4{margin:0 0 12px;font-size:16px}input{box-sizing:border-box;width:100%;padding:13px;margin:8px 0;color:var(--nivra-text);background:var(--nivra-panel-2);border:1px solid var(--nivra-line);border-radius:14px;font:inherit;font-size:13px}button{min-height:44px;padding:11px 14px;margin:4px 4px 4px 0;border:1px solid var(--nivra-line);border-radius:13px;background:var(--nivra-panel-2);color:var(--nivra-text);font:inherit;font-size:12px;font-weight:650;cursor:pointer}button:disabled{opacity:.5;cursor:default}p{line-height:1.6;font-size:12px;color:var(--nivra-muted)}.actions{display:flex;gap:4px;flex-wrap:wrap}.picker{padding:14px;margin-block:14px;background:var(--nivra-panel-2);border:1px solid var(--nivra-line);border-radius:18px}.targets{max-height:300px;overflow:auto;overscroll-behavior:contain}.target{display:flex;gap:10px;align-items:center;width:100%;text-align:start;background:transparent;border-color:transparent}.target strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.target.selected{background:var(--nivra-brand-soft);border-color:var(--nivra-brand-2)}.target img,.face{width:40px;height:40px;flex:0 0 40px;border-radius:50%;object-fit:cover}.face{display:grid;place-items:center;background:var(--nivra-brand-soft);color:var(--nivra-brand-2)}.saved-link{border-top:1px solid var(--nivra-line);padding:10px 0;font-size:12px}:is(button,input):focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}@media(max-width:380px){section{padding:14px}.actions button{flex:1 1 100%}}`],
})
export class GroupInviteShareComponent implements OnChanges {
  @Input({ required: true }) conversationId = '';
  @Input() community = false;
  @Input() title = '';
  readonly chat = inject(ChatService);
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly native = inject(NativeDeviceService);
  private readonly destroy = inject(DestroyRef);
  private revision = 0;
  private contentScope = '';
  pickerOpen = false; query = ''; selected = new Set<string>();
  link = ''; createdId = ''; destination = ''; busy = false; message = '';
  links: Array<{id:string;expiresAt:string;uses:number;maxUses:number;revokedAt:string|null}> = [];
  private path() { return `/conversations/${encodeURIComponent(this.conversationId)}/invite-links`; }
  ngOnChanges(): void { ++this.revision; this.contentScope=''; this.link=''; this.links=[]; this.selected=new Set(); this.pickerOpen=false; this.busy=false; this.message=''; }
  private scope(): string { return JSON.stringify([this.auth.session()?.user.id,this.auth.session()?.device.id,this.auth.sessionGeneration(),this.conversationId,this.revision]); }
  private current(scope:string): boolean { return !this.destroy.destroyed && scope===this.scope(); }
  validLink(): string { return this.contentScope===this.scope()?this.link:''; }
  visibleLinks(){return this.contentScope===this.scope()?this.links:[];}
  private async run(action:(scope:string)=>Promise<void>) { if(this.busy||!this.auth.session())return;const scope=this.scope();this.busy=true;this.message='';try{await action(scope);}catch{if(this.current(scope))this.message='No se pudo completar. Revisa tu conexión y tus permisos de administrador.';}finally{if(this.current(scope))this.busy=false;} }
  async create() { await this.run(async scope=>{const result=await firstValueFrom(this.api.post<{id:string;code:string}>(this.path(),{}).pipe(timeout(20000)));if(!this.current(scope))return;this.createdId=result.id;this.link=`https://nivrapp-secure.vercel.app/group/invite#${encodeURIComponent(result.code)}`;this.contentScope=scope;}); }
  async copy() { const link=this.validLink();if(!link)return;await this.run(async scope=>{await this.native.copyToClipboard(link);if(this.current(scope))this.message='Enlace copiado.';}); }
  private invitation():string{return `Te invito a ${this.community?'la comunidad':'un grupo'}${this.title?' '+this.title:' de Nivra'}.\n${this.validLink()}`;}
  async shareOutside(){if(!this.validLink())return;await this.run(async scope=>{const result=await this.native.shareText(this.invitation(),'Invitación a Nivra');if(this.current(scope)&&result==='copied')this.message='Invitación copiada. Pégala en la app que prefieras.';});}
  private allTargets():InviteTarget[]{
    const conversations=this.chat.conversations().filter(c=>this.chat.canSendToConversation(c)&&!this.chat.isConversationBlocked(c.id));
    const users=new Set(conversations.filter(c=>!this.chat.isGroup(c)).flatMap(c=>c.participants.filter(p=>!p.removedAt&&p.userId!==this.auth.session()?.user.id).map(p=>p.userId)));
    return [...conversations.map(conversation=>({id:'chat:'+conversation.id,title:this.chat.conversationTitle(conversation),photo:this.chat.conversationPhoto(conversation),conversation})),...this.chat.contacts().filter(c=>!users.has(c.userId)).map(contact=>({id:'contact:'+contact.userId,title:contact.displayName||contact.alias,photo:contact.profilePhotoDataUrl||'',contact}))];
  }
  targets():InviteTarget[]{const q=this.query.trim().toLocaleLowerCase();return this.allTargets().filter(t=>!q||t.title.toLocaleLowerCase().includes(q)).slice(0,120);}
  toggle(id:string){const next=new Set(this.selected);next.has(id)?next.delete(id):next.add(id);this.selected=next;}
  async send(){if(!this.validLink()||!this.selected.size)return;const targets=this.allTargets().filter(t=>this.selected.has(t.id));const text=this.invitation();await this.run(async scope=>{
    let sent=0;for(const target of targets){if(!this.current(scope))return;try{const c=target.contact;const person=c?{...c,id:c.userId,isDiscoverable:false,allowStoryReposts:false,isContact:true,friendshipState:'Friends'} as UserSummary:null;
      const conversation=target.conversation??await this.chat.createDirectConversation(person!);if(!this.current(scope))return;await this.chat.sendText(conversation,text);if(!this.current(scope))return;this.selected.delete(target.id);sent++;}catch{/* Failed destinations remain selected for retry. */}}
    if(!this.current(scope))return;this.message=this.selected.size?`Se enviaron ${sent} invitaciones. Quedan ${this.selected.size} por reintentar.`:`Invitación enviada a ${sent} chats.`;if(!this.selected.size)this.pickerOpen=false;
  });}
  async load() { await this.run(async scope=>{const links=await firstValueFrom(this.api.get<typeof this.links>(this.path()).pipe(timeout(20000)));if(this.current(scope)){this.links=links;this.contentScope=scope;}}); }
  async revoke(id:string) { await this.run(async scope=>{await firstValueFrom(this.api.delete(`${this.path()}/${encodeURIComponent(id)}`).pipe(timeout(20000)));if(!this.current(scope))return;if(id===this.createdId){this.link='';this.pickerOpen=false;}this.links=this.links.map(item=>item.id===id?{...item,revokedAt:new Date().toISOString()}:item);this.message='Enlace revocado.';}); }
}
