import { Component, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { IdentityTrustService } from '../../core/services/identity-trust.service';
import { PublicKeyDirectory } from '../../core/models/nivra.models';
import { CryptoService } from '../../core/services/crypto.service';
import { deriveUnverifiedSafetyNumber } from '../../core/utils/identity-fingerprint';

@Component({standalone:true,imports:[FormsModule],template:`<main><h1>Verificar identidad</h1><p>Compara este código con tu contacto en persona o mediante un canal de confianza. Incluye sus dispositivos registrados; añadir o retirar uno cambia el código.</p>
  @if(qr){<img [src]="qr" alt="Código QR de comparación" width="256" height="256"><p class="code">{{code}}</p><label>Código que muestra tu contacto<input [(ngModel)]="comparison" autocomplete="off"></label><label>O lee una imagen de su QR<input type="file" accept="image/*" (change)="scan($event)"></label><div id="identity-file-reader"></div><button [disabled]="busy" (click)="confirm()">Comparar y guardar verificación</button>}
  <p role="status">{{message}}</p><button (click)="back()">Volver a Chats</button></main>`,styles:[`:host{display:block;height:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;box-sizing:border-box;padding-bottom:calc(28px + env(safe-area-inset-bottom))}*{box-sizing:border-box}main{max-width:560px;margin:24px auto;padding:24px;color:var(--ion-text-color);background:var(--ion-background-color)}p{line-height:1.6}.code{font-family:monospace;overflow-wrap:anywhere;font-size:20px}img{display:block;background:white;margin:auto;max-width:100%;height:auto;border-radius:12px}h1{font-size:clamp(24px,6vw,32px)}input{min-width:0;border:1px solid var(--nivra-line);border-radius:12px}button{min-height:48px;max-width:100%}@media(max-width:600px){main{margin:0 auto;padding:20px 16px}.code{font-size:16px}button{width:100%;margin:8px 0}}label{display:block;margin:16px 0}input{display:block;width:100%;padding:12px;background:inherit;color:inherit}button{padding:14px;margin:8px;border-radius:12px;background:var(--ion-color-primary,#087f68);color:var(--ion-color-primary-contrast,#fff)}`]})
export class IdentityVerificationPage implements OnInit {
  private crypto=inject(CryptoService);
  private auth=inject(AuthService);private api=inject(NivraApiService);private trust=inject(IdentityTrustService);private route=inject(ActivatedRoute);private router=inject(Router);
  code='';qr='';comparison='';message='';busy=false;private target='';
  async ngOnInit(){this.target=this.route.snapshot.paramMap.get('userId')||'';try{const pair=await this.load();this.code=(await deriveUnverifiedSafetyNumber(pair[0],pair[1])).display;const qr=await import('qrcode');this.qr=await qr.toDataURL(`nivra-identity-v1:${this.code}`,{width:256,margin:2});}catch{this.message='No se pudieron cargar las llaves. Reintenta con conexión.';}}
  private async load():Promise<[PublicKeyDirectory,PublicKeyDirectory]>{
    const current=this.auth.session();if(!current || !this.target || current.user.id===this.target)throw new Error();
    const list=await firstValueFrom(this.api.post<PublicKeyDirectory[]>('/keys/batch',{userIds:[current.user.id,this.target],aliases:[]}));
    const own=list.find(x=>x.userId===current.user.id),other=list.find(x=>x.userId===this.target);if(!own||!other)throw new Error();
    const local=await this.crypto.currentKeyMaterial(current.user.alias,current.device.id);
    const published=this.crypto.parsePublicJwk(own.devices.find(x=>x.deviceId===current.device.id)?.keyBundle?.identityKey);
    if(!published || published.x!==local.publicJwk.x || published.y!==local.publicJwk.y) throw new Error('Tu llave publicada no coincide con este dispositivo.');
    return [own,other];
  }
  async confirm(){if(this.busy)return;this.busy=true;try{
    const normalized=this.comparison.replace(/^nivra-identity-v1:/,'').replace(/\s/g,'').toLowerCase();
    if(!this.code || normalized!==this.code.replace(/\s/g,'')){this.message='Los códigos no coinciden. No se ha aceptado la identidad.';return;}
    const pair=await this.load();if((await deriveUnverifiedSafetyNumber(pair[0],pair[1])).display!==this.code){this.message='Las llaves cambiaron durante la comparación. Vuelve a abrir esta pantalla.';return;}
    const current=this.auth.session()!;await this.trust.confirm(JSON.stringify([current.user.id,current.device.id]),pair[1]);this.message='Código comparado y verificación guardada en este dispositivo.';
  }catch{this.message='No se pudo guardar la verificación. Reintenta con conexión.';}finally{this.busy=false;}}
  async scan(event:Event){const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;let scanner:import('html5-qrcode').Html5Qrcode|undefined;try{const module=await import('html5-qrcode');scanner=new module.Html5Qrcode('identity-file-reader');this.comparison=await scanner.scanFile(file,false);await this.confirm();}catch{this.message='No se pudo leer el QR de la imagen.';}finally{scanner?.clear();}}
  back(){void this.router.navigateByUrl('/app/chats');}
}
