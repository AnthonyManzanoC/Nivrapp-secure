import { Component, DestroyRef, OnInit, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { firstValueFrom, timeout } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { NivraApiService } from '../../core/services/nivra-api.service';

interface InvitePreview { name:string; members:number; photo?:string|null; communityId?:string|null; }

@Component({standalone:true,template:`<main><small>INVITACIÓN PRIVADA</small>@if(visiblePreview;as item){@if(item.photo){<img class="invite-photo" [src]="item.photo" alt="">}<h1>{{item.name}}</h1><p>{{item.communityId?'Comunidad':'Grupo'}} · {{item.members}} participantes</p><p>Únete para recibir los próximos mensajes. El historial anterior permanece protegido.</p><button class="primary" [disabled]="busy" (click)="join()">{{busy?'Entrando…':item.communityId?'Unirme a la comunidad':'Unirme al grupo'}}</button>}@else{<h1>Invitación a Nivra</h1>}<p role="status">{{message}}</p><button (click)="back()">Volver a Chats</button></main>`,styles:[`main{width:min(90vw,480px);margin:clamp(24px,7vh,64px) auto;padding:28px;box-sizing:border-box;color:var(--nivra-text);background:var(--nivra-panel-solid);border:1px solid var(--nivra-line);border-radius:26px}small{font-size:11px;letter-spacing:.13em;font-weight:750;color:var(--nivra-brand-2)}img.invite-photo{display:block;width:88px;height:88px;margin-top:20px;border-radius:24px;object-fit:cover}h1{overflow-wrap:anywhere;letter-spacing:-.035em}button{min-height:44px;padding:12px 16px;margin:4px;border-radius:14px;font:inherit;background:var(--nivra-panel-2);color:var(--nivra-text);border:1px solid var(--nivra-line)}button.primary{background:var(--nivra-brand);color:var(--nivra-on-brand);border-color:transparent;font-weight:700}p{line-height:1.6;color:var(--nivra-muted)}`]})
export class GroupInvitePage implements OnInit {
  private auth=inject(AuthService);private api=inject(NivraApiService);private chat=inject(ChatService);private router=inject(Router);private route=inject(ActivatedRoute);private destroy=inject(DestroyRef);
  code='';busy=false;message='';private preview:InvitePreview|null=null;private previewScope='';
  private scope():string{return JSON.stringify([this.auth.session()?.user.id,this.auth.session()?.device.id,this.auth.sessionGeneration()]);}
  private current(scope:string):boolean{return !this.destroy.destroyed&&scope===this.scope();}
  get visiblePreview():InvitePreview|null{return this.current(this.previewScope)?this.preview:null;}
  async ngOnInit(){
    this.code=this.route.snapshot.fragment||'';
    if(!/^[A-Za-z0-9_-]{43}$/.test(this.code)){this.message='El enlace no es válido.';return;}
    const restored=await this.auth.ensureSessionRestored();if(this.destroy.destroyed)return;
    if(!restored){sessionStorage.setItem('nivra_pending_group_invite',this.code);await this.router.navigateByUrl('/auth');return;}
    const scope=this.scope();this.message='Comprobando invitación…';
    try{const item=await firstValueFrom(this.api.post<InvitePreview>('/group-invites/preview',{code:this.code}).pipe(timeout(20000)));if(this.current(scope)){this.preview=item;this.previewScope=scope;this.message='';}}
    catch{if(this.current(scope))this.message='La invitación caducó, fue revocada o no está disponible.';}
  }
  async join(){
    if(this.busy||!this.visiblePreview)return;
    const scope=this.scope();this.busy=true;
    try{
      const result=await firstValueFrom(this.api.post<{conversationId:string;communityId?:string|null}>('/group-invites/accept',{code:this.code}).pipe(timeout(20000)));
      if(!this.current(scope))return;
      void this.chat.refreshChats().catch(()=>undefined);
      if(result.communityId)await this.router.navigate(['/app/communities'],{queryParams:{id:result.communityId}});
      else await this.router.navigate(['/app/chats',result.conversationId]);
    }catch{if(this.current(scope))this.message='No se pudo entrar. Reintenta o solicita una nueva invitación al administrador.';}
    finally{if(!this.destroy.destroyed)this.busy=false;}
  }
  back(){void this.router.navigateByUrl('/app/chats');}
}
