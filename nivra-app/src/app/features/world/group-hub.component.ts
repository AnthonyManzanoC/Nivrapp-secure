import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ChatService } from '../../core/services/chat.service';
import { AuthService } from '../../core/services/auth.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({
  selector: 'app-group-hub', standalone: true, imports: [FormsModule, RouterLink, TranslatePipe],
  template: `<section aria-labelledby="group-hub-title">
    <header><div><small>{{'GROUP_HUB.LABEL' | translate:'TU GENTE, EN UN LUGAR'}}</small><h2 id="group-hub-title">{{'GROUP_HUB.TITLE' | translate:'Tus grupos'}}</h2></div><span>{{groups().length}}</span></header>
    <p>{{'GROUP_HUB.COPY' | translate:'Retoma una conversación o encuentra los avisos de tus administradores.'}}</p>
    <label class="search"><span>{{'COMMON.SEARCH' | translate:'Buscar'}}</span><input type="search" [ngModel]="query()" (ngModelChange)="query.set($event)" [placeholder]="'GROUP_HUB.SEARCH' | translate:'Nombre del grupo'" /></label>
    <div class="filters" aria-label="Filtrar grupos">
      <button type="button" [attr.aria-pressed]="!announcements()" (click)="announcements.set(false)">{{'COMMON.ALL' | translate:'Todos'}}</button>
      <button type="button" [attr.aria-pressed]="announcements()" (click)="announcements.set(true)">{{'GROUP_HUB.ANNOUNCEMENTS' | translate:'Solo avisos'}}</button>
    </div>
    <div class="groups">@for(group of filtered(); track group.id){
      <a [routerLink]="['/app/chats',group.id]">
        <span class="mark" aria-hidden="true">{{chat.avatarLabel(group)}}</span>
        <span class="copy"><strong>{{chat.conversationTitle(group)}}</strong><small>{{group.settings?.sendMessages === 'admins' ? ('GROUP_HUB.ADMIN_POSTS' | translate:'Publican los administradores') : ('GROUP_HUB.GROUP_CHAT' | translate:'Conversación grupal')}}</small></span><span aria-hidden="true">↗</span>
      </a>
    } @empty {<p class="empty">{{query() || announcements() ? ('GROUP_HUB.NO_RESULTS' | translate:'No hay grupos que coincidan con este filtro.') : ('GROUP_HUB.EMPTY' | translate:'Cuando crees un grupo o aceptes una invitación, lo encontrarás aquí.')}}</p>}</div>
  </section>`,
  styles: [`:host{display:block;grid-column:span 12}section{padding:24px;border:1px solid var(--nivra-line);border-radius:22px;background:var(--nivra-panel-solid);color:var(--nivra-text)}header{display:flex;justify-content:space-between;align-items:center;gap:12px}header small{font-size:11px;letter-spacing:.12em;color:var(--nivra-brand-2);font-weight:700}h2{font-size:24px;letter-spacing:-.5px;margin:8px 0}p{color:var(--nivra-muted);line-height:1.6}.search{display:flex;align-items:center;gap:12px;background:var(--nivra-panel-2);padding:4px 14px;border-radius:12px}.search span{font-size:13px;color:var(--nivra-muted)}input{min-width:0;flex:1;background:transparent;color:inherit;border:0;padding:12px;font:inherit}.filters{display:flex;gap:8px;margin:16px 0}button{min-height:44px;padding:10px 18px;border-radius:24px;border:1px solid var(--nivra-line);background:transparent;color:inherit}button[aria-pressed=true]{background:var(--nivra-brand);color:#05271e;border-color:transparent;font-weight:700}.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;max-height:360px;overflow:auto}a{display:flex;align-items:center;gap:12px;padding:16px;border:1px solid var(--nivra-line);border-radius:16px;text-decoration:none;color:inherit}a:hover{background:var(--nivra-panel-2)}.mark{display:grid;place-items:center;flex:0 0 42px;height:42px;border-radius:14px;background:var(--nivra-panel-2);color:var(--nivra-brand-2);font-weight:700}.copy{display:grid;gap:6px;min-width:0;flex:1}.copy strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.copy small{color:var(--nivra-muted);font-size:12px}.empty{padding:12px}@media(max-width:600px){section{padding:18px}}`],
})
export class GroupHubComponent {
  readonly chat = inject(ChatService);
  private readonly auth = inject(AuthService);
  readonly query = signal('');
  readonly announcements = signal(false);
  readonly groups = computed(() => this.chat.conversations().filter(group =>
    this.chat.isGroup(group) && group.participants.some(member => member.userId === this.auth.session()?.user.id && !member.removedAt)));
  readonly filtered = computed(() => this.groups().filter(group =>
    (!this.announcements() || group.settings?.sendMessages === 'admins') &&
    this.chat.conversationTitle(group).toLocaleLowerCase().includes(this.query().trim().toLocaleLowerCase())));
}
