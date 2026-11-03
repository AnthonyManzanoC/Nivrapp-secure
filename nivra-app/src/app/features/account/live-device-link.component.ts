import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AuthService } from '../../core/services/auth.service';
import { SignalrService } from '../../core/services/signalr.service';
import { TransientNoticeDirective } from '../../shared/transient-notice.directive';

@Component({selector:'app-live-device-link',standalone:true,imports:[TransientNoticeDirective],template:`
  <section class="live-device">
    <h3>Mensajes en este equipo</h3><p>Si acabas de iniciar sesión, autoriza este equipo desde otro donde ya uses Nivra. El historial se puede sincronizar después.</p>
    @if(qr();as link){
      <img [src]="link.image" alt="QR para autorizar solo mensajes nuevos">
      <p>En tu equipo habitual abre <strong>Cuenta → Vincular por QR</strong> y escanea este código. Caduca en tres minutos.</p>
      <div class="actions"><button type="button" (click)="copy(link.code)">Copiar código</button><button type="button" (click)="close()">Cerrar</button></div>
    }@else{<button class="primary" type="button" [disabled]="busy()" (click)="create()">{{busy()?'Preparando…':'Autorizar mensajes nuevos'}}</button>}
    @if(notice()){<p role="status" [appTransientNotice]="notice()">{{notice()}}</p>}
  </section>`,styles:[`
    :host{display:block}.live-device{margin:16px 0 0;padding:16px;border:1px solid var(--nivra-line);border-radius:18px;background:var(--nivra-panel-2)}
    h3{margin:0;font-size:16px;color:var(--nivra-text)}p{font-size:13px;line-height:1.55;color:var(--nivra-muted)}
    img{display:block;width:min(200px,100%);margin:16px auto;border-radius:16px;background:#fff}button{min-height:42px;padding:9px 14px;border:1px solid var(--nivra-line);border-radius:12px;background:var(--nivra-panel-solid);color:var(--nivra-text);font:inherit;font-size:13px;font-weight:700}button.primary{background:var(--nivra-brand);color:var(--nivra-on-brand)}.actions{display:flex;gap:8px;flex-wrap:wrap}
  `]})
export class LiveDeviceLinkComponent {
  private readonly auth=inject(AuthService);
  private readonly destroy=inject(DestroyRef);
  private readonly link=signal<{scope:string;code:string;image:string}|null>(null);
  private timer?:ReturnType<typeof setTimeout>;
  readonly busy=signal(false);
  readonly notice=signal('');
  readonly qr=computed(()=>this.link()?.scope===this.scope()?this.link():null);
  private scope():string{return JSON.stringify([this.auth.session()?.user.id,this.auth.session()?.device.id,this.auth.sessionGeneration()]);}
  constructor(){
    inject(SignalrService).events$.pipe(takeUntilDestroyed()).subscribe(event=>{
      const data=event.payload as {deviceId?:string;liveAuthorized?:boolean}|null;
      if(event.type==='device.listChanged'&&data?.liveAuthorized&&data.deviceId===this.auth.session()?.device.id&&this.qr()){
        this.close();this.notice.set('Equipo autorizado. Los mensajes nuevos se sincronizan sin copiar el historial.');
      }
    });
    this.destroy.onDestroy(()=>clearTimeout(this.timer));
  }
  async create():Promise<void>{
    if(this.busy())return;
    const scope=this.scope();this.busy.set(true);this.notice.set('');
    try{
      const code=await this.auth.liveDeviceAuthorizationCode();
      const qr=await import('qrcode');const image=await qr.toDataURL(code,{width:230,margin:2,errorCorrectionLevel:'M'});
      if(this.destroy.destroyed||scope!==this.scope())return;
      this.close();this.link.set({scope,code,image});this.timer=setTimeout(()=>{if(!this.destroy.destroyed){this.close();this.notice.set('El código caducó. Genera otro para continuar.');}},180_000);
    }catch(error){if(!this.destroy.destroyed&&scope===this.scope())this.notice.set(error instanceof Error?error.message:'No se pudo preparar el código.');}
    finally{if(!this.destroy.destroyed)this.busy.set(false);}
  }
  async copy(code:string):Promise<void>{try{await navigator.clipboard.writeText(code);this.notice.set('Código copiado. Pégalo en Vincular por QR en tu equipo habitual.');}catch{this.notice.set('Puedes escanear el código con la cámara del otro equipo.');}}
  close():void{clearTimeout(this.timer);this.link.set(null);}
}
