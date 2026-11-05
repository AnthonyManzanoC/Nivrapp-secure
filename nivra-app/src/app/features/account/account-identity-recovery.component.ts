import { Component, DestroyRef, Injector, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AccountIdentityService } from '../../core/services/account-identity.service';
import { RatchetMessagingService } from '../../core/services/ratchet-messaging.service';
import { AuthService } from '../../core/services/auth.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { TransientNoticeDirective } from '../../shared/transient-notice.directive';

@Component({selector:'app-account-identity-recovery',standalone:true,imports:[FormsModule,TransientNoticeDirective],template:`
  <section aria-labelledby="account-identity-title"><header><span class="mark" aria-hidden="true">◇</span><div><small>IDENTIDAD Y DISPOSITIVOS</small><h3 id="account-identity-title">{{identity.state()==='ready'?'Tu identidad, protegida':'Recuperación de identidad'}}</h3></div></header>
    <p>Conserva tu identidad al cambiar de equipo. La copia de tu llave raíz se cifra con tu contraseña y tiene una frase de respaldo de 24 palabras.</p>
    @if(identity.state()==='ready'){
      <div class="actions"><button type="button" (click)="reveal()" [disabled]="busy">Ver frase de recuperación</button><button type="button" (click)="editing=!editing;hidePhrase()">Actualizar protección</button></div>
    }
    @if(identity.state()!=='ready'||editing){
      <form (ngSubmit)="activate()">
        <label>Contraseña actual<input type="password" name="identityPassword" [(ngModel)]="password" autocomplete="current-password" [disabled]="busy" required></label>
        <label class="switch"><input type="checkbox" name="identityRecovery" [(ngModel)]="recovering" [disabled]="busy"> Tengo una frase de recuperación</label>
        @if(recovering){<label>Tu frase de 24 palabras<textarea name="identityPhrase" [(ngModel)]="recoveryPhrase" rows="3" autocomplete="off" autocapitalize="none" spellcheck="false" [disabled]="busy"></textarea></label>}
        <button class="primary" type="submit" [disabled]="busy||!password||(recovering&&!recoveryPhrase.trim())">{{busy?'Protegiendo tu identidad…':recovering?'Recuperar identidad':'Activar recuperación segura'}}</button>
      </form>
    }
    @if(phrase){<div class="phrase"><strong>Guárdala en un lugar privado</strong><p>No la compartas. Permite recuperar tu identidad aunque pierdas todos tus equipos.</p><output>{{phrase}}</output><button type="button" (click)="hidePhrase()">Ocultar frase</button><small>Se ocultará automáticamente en un minuto.</small></div>}
    @if(message){<p role="status" [appTransientNotice]="message" (noticeExpired)="message=''">{{message}}</p>}
    <p class="hint">Esta copia protege la identidad de la cuenta. Para recuperar mensajes anteriores necesitas sus llaves guardadas o sincronizar el historial desde otro equipo.</p>
  </section>`,styles:[`
  :host{display:block}section{border:1px solid var(--nivra-line);background:var(--nivra-panel-solid);color:var(--nivra-text);padding:20px;border-radius:22px}header{display:flex;gap:12px;align-items:center}.mark{display:grid;place-items:center;width:44px;height:44px;flex:0 0 44px;border-radius:14px;color:var(--nivra-brand-2);background:var(--nivra-brand-soft);font-size:28px}h3{margin:4px 0;font-size:16px}small{color:var(--nivra-muted);font-size:10px;line-height:1.5}p{font-size:12px;line-height:1.65;color:var(--nivra-muted)}form,label{display:grid;gap:8px}form{gap:14px}label{font-size:12px;font-weight:650}input,textarea,button{font:inherit;box-sizing:border-box}input,textarea{width:100%;min-width:0;padding:13px;color:var(--nivra-text);background:var(--nivra-panel-2);border:1px solid var(--nivra-line);border-radius:13px}button{min-height:44px;border:1px solid var(--nivra-line);border-radius:13px;background:var(--nivra-panel-2);color:var(--nivra-text);padding:10px 14px;cursor:pointer;font-size:12px;font-weight:650}button:disabled{opacity:.6;cursor:default}.primary{background:var(--nivra-brand);color:var(--nivra-on-brand);border-color:transparent}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.switch{display:flex;align-items:center;gap:10px}.switch input{width:20px;height:20px}.phrase{padding:16px;border:1px solid var(--nivra-selection-line);background:var(--nivra-selection);border-radius:16px;margin-top:16px}.phrase output{display:block;font-size:16px;line-height:1.8;overflow-wrap:anywhere;padding:12px 0;user-select:text}.phrase small{display:block;margin-top:8px}.hint{margin-bottom:0}:is(button,input,textarea):focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}`]})
export class AccountIdentityRecoveryComponent {
  readonly identity=inject(AccountIdentityService);
  private readonly injector=inject(Injector);
  private readonly auth=inject(AuthService);
  private readonly appLock=inject(AppLockService);
  private readonly destroy=inject(DestroyRef);
  password='';recoveryPhrase='';phrase='';message='';recovering=false;editing=false;busy=false;
  private hideTimer:ReturnType<typeof setTimeout>|null=null;
  private generation=0;
  constructor(){effect(()=>{this.auth.session();this.auth.sessionGeneration();this.appLock.isContentLocked();this.clear();});this.destroy.onDestroy(()=>this.clear());}
  private clear():void{++this.generation;this.password='';this.recoveryPhrase='';this.hidePhrase();this.message='';this.busy=false;this.editing=false;}
  hidePhrase():void{this.phrase='';if(this.hideTimer)clearTimeout(this.hideTimer);this.hideTimer=null;}
  async reveal():Promise<void>{this.hidePhrase();const generation=this.generation;try{const phrase=await this.identity.phrase();if(this.destroy.destroyed||generation!==this.generation)return;this.phrase=phrase;this.hideTimer=setTimeout(()=>this.hidePhrase(),60000);}catch{this.message='Activa o recupera primero tu identidad.';}}
  async activate():Promise<void>{if(this.busy||!this.password)return;const generation=this.generation;const password=this.password;this.busy=true;this.message='';this.hidePhrase();
    try{await this.identity.verifyPassword(password);if(this.destroy.destroyed||generation!==this.generation)return;await this.injector.get(RatchetMessagingService).activateAccountIdentity(password,this.recovering?this.recoveryPhrase:undefined);if(this.destroy.destroyed||generation!==this.generation)return;this.editing=false;this.recoveryPhrase='';this.message='Identidad protegida. Guarda tu frase de recuperación en un lugar privado.';}
    catch{if(!this.destroy.destroyed&&generation===this.generation)this.message='No se pudo completar. Comprueba tu contraseña, tu frase de respaldo y tu conexión.';}
    finally{if(!this.destroy.destroyed&&generation===this.generation){this.password='';this.busy=false;}}
  }
}
