import { Component, OnInit, inject } from '@angular/core';
import { Router, ActivatedRoute } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { NivraApiService } from '../../core/services/nivra-api.service';

@Component({standalone:true,template:`<main><h1>Invitación a Nivra</h1>@if(preview){<h2>{{preview.name}}</h2><p>{{preview.members}} participantes</p><p>Te unirás para recibir los próximos mensajes. Esta invitación no entrega el historial anterior.</p><button [disabled]="busy" (click)="join()">Unirme al grupo</button>}<p role="status">{{message}}</p><button (click)="back()">Volver a Chats</button></main>`,styles:[`main{max-width:480px;margin:48px auto;padding:24px;color:var(--ion-text-color);background:var(--ion-background-color);border-radius:20px}button{padding:14px;margin:8px;border-radius:12px;background:var(--ion-color-primary,#087f68);color:var(--ion-color-primary-contrast,#fff)}p{line-height:1.6}`]})
export class GroupInvitePage implements OnInit {
  private auth=inject(AuthService);private api=inject(NivraApiService);private chat=inject(ChatService);private router=inject(Router);private route=inject(ActivatedRoute);
  code='';busy=false;message='';preview:{name:string;members:number}|null=null;
  async ngOnInit(){
    this.code=this.route.snapshot.fragment||'';
    if(!/^[A-Za-z0-9_-]{43}$/.test(this.code)){this.message='El enlace no es válido.';return;}
    if(!await this.auth.ensureSessionRestored()){sessionStorage.setItem('nivra_pending_group_invite',this.code);await this.router.navigateByUrl('/auth');return;}
    try{this.preview=await firstValueFrom(this.api.post<{name:string;members:number}>('/group-invites/preview',{code:this.code}));}catch{this.message='La invitación caducó, fue revocada o no está disponible.';}
  }
  async join(){if(this.busy)return;this.busy=true;try{const result=await firstValueFrom(this.api.post<{conversationId:string}>('/group-invites/accept',{code:this.code}));await this.chat.bootstrap();await this.router.navigate(['/app/chats',result.conversationId]);}catch{this.message='No se pudo entrar. Reintenta o solicita una nueva invitación al administrador.';}finally{this.busy=false;}}
  back(){void this.router.navigateByUrl('/app/chats');}
}
