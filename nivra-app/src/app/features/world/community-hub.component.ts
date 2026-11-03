import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CommunityService } from '../../core/services/community.service';

@Component({selector:'app-community-hub',standalone:true,imports:[RouterLink],template:`
  <section class="community-hub"><header><div><small>JUNTOS, MEJOR</small><h2>Tus comunidades</h2></div><nav aria-label="Acciones de comunidades"><a routerLink="/app/communities" class="view-all">Ver comunidades</a><a routerLink="/app/communities" [queryParams]="{create:1}" class="create">+ Nueva comunidad</a></nav></header>
  <p>Reúne tus grupos y comparte avisos en un mismo espacio.</p>
  @if(communities.loading()){<p role="status">Actualizando comunidades…</p>}
  <div class="community-cards">@for(item of communities.items();track item.id){<a [routerLink]="['/app/communities']" [queryParams]="{id:item.id}"><span class="community-face">@if(item.photo){<img [src]="item.photo" alt="">}@else{<span>{{item.name.slice(0,2).toUpperCase()}}</span>}</span><span><strong>{{item.name}}</strong><small>{{item.groups.length}} grupos · {{item.memberCount}} miembros</small></span><span aria-hidden="true">›</span></a>}@empty{<a class="community-empty" routerLink="/app/communities" [queryParams]="{create:1}">Crea tu primera comunidad para organizar tus grupos.</a>}</div>
  </section>`,styles:[`
   :host{display:block;margin-bottom:24px}.community-hub{padding:24px;border:1px solid var(--nivra-line);border-radius:24px;background:linear-gradient(145deg,color-mix(in srgb,var(--nivra-brand) 8%,var(--nivra-panel-solid)),var(--nivra-panel-solid));color:var(--nivra-text)}
   header{display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap}header small{font-size:10px;font-weight:750;letter-spacing:.12em;color:var(--nivra-brand-2)}h2{margin:6px 0;font-size:24px}p{color:var(--nivra-muted);font-size:13px;line-height:1.6}
   a{color:inherit;text-decoration:none}nav{display:flex;flex-wrap:wrap;gap:8px}.create,.view-all{min-height:44px;display:flex;align-items:center;padding:10px 14px;border-radius:14px;font-size:13px;font-weight:700}.create{background:var(--nivra-brand);color:var(--nivra-on-brand)}.view-all{background:var(--nivra-panel-solid);color:var(--nivra-brand-2);border:1px solid var(--nivra-line)}
   .community-cards{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr))}.community-cards>a{display:flex;align-items:center;gap:12px;padding:14px;border:1px solid var(--nivra-line);border-radius:18px;background:var(--nivra-panel-solid);min-width:0}.community-cards>a>span:nth-child(2){flex:1;min-width:0;display:grid;gap:5px}strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}small{font-size:12px;color:var(--nivra-muted)}
   .community-face{width:48px;height:48px;flex:0 0 48px;border-radius:16px;overflow:hidden;display:grid;place-items:center;background:var(--nivra-panel-2);color:var(--nivra-brand-2);font-weight:750}.community-face img{width:100%;height:100%;object-fit:cover}.community-empty{font-size:13px;color:var(--nivra-muted)}a:focus-visible{outline:2px solid var(--nivra-brand);outline-offset:2px}
  `]})
export class CommunityHubComponent {readonly communities=inject(CommunityService);}
