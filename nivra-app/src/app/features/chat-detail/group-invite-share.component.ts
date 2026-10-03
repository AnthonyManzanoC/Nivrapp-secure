import { Component, Input, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { ChatService } from '../../core/services/chat.service';

@Component({
  selector: 'app-group-invite-share', standalone: true, imports: [CommonModule, FormsModule],
  template: `<section><h3>Invitar con enlace</h3><p>Válido por 24 horas y hasta 25 incorporaciones. Quien lo tenga puede unirse; puedes revocarlo.</p>
    <button type="button" [disabled]="busy" (click)="create()">Crear enlace</button>
    @if (link) { <input aria-label="Enlace de invitación" readonly [value]="link"><button type="button" (click)="copy()">Copiar enlace</button>
      <label>Enviar por un chat<select [(ngModel)]="destination"><option value="">Elige un chat</option>@for (item of chat.conversations(); track item.id) {<option [value]="item.id">{{item.title || item.groupName || 'Conversación'}}</option>}</select></label>
      <button type="button" [disabled]="busy || !destination" (click)="send()">Enviar invitación</button> }
    <button type="button" [disabled]="busy" (click)="load()">Ver enlaces creados</button>
    @for (item of links; track item.id) {<div>{{item.expiresAt | date:'short'}} · {{item.uses}}/{{item.maxUses}} usos
      @if (!item.revokedAt) {<button type="button" [disabled]="busy" (click)="revoke(item.id)">Revocar</button>} @else {<span>Revocado</span>}</div>}
    <p role="status">{{message}}</p></section>`,
  styles: [`:host{display:block}section{padding:16px;border:1px solid var(--ion-color-medium);border-radius:16px;color:var(--ion-text-color);background:var(--ion-background-color)}input,select{width:100%;padding:12px;margin:8px 0;color:inherit;background:inherit}button{padding:12px;margin:4px;border-radius:10px;background:var(--ion-color-primary,#087f68);color:var(--ion-color-primary-contrast,#fff)}button:disabled{opacity:.5}p{line-height:1.5}`],
})
export class GroupInviteShareComponent {
  @Input({ required: true }) conversationId = '';
  readonly chat = inject(ChatService);
  private readonly api = inject(NivraApiService);
  link = ''; createdId = ''; destination = ''; busy = false; message = '';
  links: Array<{id:string;expiresAt:string;uses:number;maxUses:number;revokedAt:string|null}> = [];
  private path() { return `/conversations/${encodeURIComponent(this.conversationId)}/invite-links`; }
  private async run(action:()=>Promise<void>) { this.busy=true;this.message='';try{await action();}catch{this.message='No se pudo completar. Revisa tu conexión y tus permisos de administrador.';}finally{this.busy=false;} }
  async create() { await this.run(async()=>{const result=await firstValueFrom(this.api.post<{id:string;code:string}>(this.path(),{}));this.createdId=result.id;const origin=location.hostname==='localhost' && location.port ? location.origin : 'https://nivrapp-secure.vercel.app';this.link=`${origin}/group/invite#${result.code}`;}); }
  async copy() { await this.run(async()=>{await navigator.clipboard.writeText(this.link);this.message='Enlace copiado.';}); }
  async send() { await this.run(async()=>{const target=this.chat.conversations().find(x=>x.id===this.destination);if(!target||!this.link)throw new Error();await this.chat.sendText(target,`Te invito a un grupo de Nivra:\n${this.link}`);this.message='Invitación enviada.';}); }
  async load() { await this.run(async()=>{this.links=await firstValueFrom(this.api.get<typeof this.links>(this.path()));}); }
  async revoke(id:string) { await this.run(async()=>{await firstValueFrom(this.api.delete(`${this.path()}/${encodeURIComponent(id)}`));if(id===this.createdId)this.link='';this.links=await firstValueFrom(this.api.get<typeof this.links>(this.path()));this.message='Enlace revocado.';}); }
}
