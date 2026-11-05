import { Component, inject } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { callOutline, chatbubbleOutline, closeOutline, videocamOutline } from 'ionicons/icons';
import { CallsService } from '../core/services/calls.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-call-result', standalone: true, imports: [IonIcon],
  host: { '[class.expanded-result]': 'expanded()' },
  template: `
    @if (calls.lastResult(); as result) {
      <aside class="call-result" [class.video]="result.call.type === 'Video'" role="status" aria-live="polite">
        <div class="result-heading">
          <span class="result-avatar" aria-hidden="true">
            @if(calls.callPhoto(result.call)){<img [src]="calls.callPhoto(result.call)" alt="">}
            @else{<ion-icon [name]="result.call.type === 'Video' ? 'videocam-outline' : 'call-outline'" />}
          </span>
          <div class="result-copy"><small>{{result.call.type === 'Video' ? 'Videollamada' : 'Llamada de voz'}}</small><strong>{{calls.callTitle(result.call)}}</strong></div>
          <button class="dismiss" type="button" aria-label="Cerrar aviso de llamada" (click)="calls.dismissCallResult()"><ion-icon name="close-outline" /></button>
        </div>
        <h2>{{result.replied ? 'Respuesta enviada a la cola' : result.kind === 'missed' ? (result.incoming ? 'Llamada perdida' : 'No hubo respuesta') : result.kind === 'busy' ? 'Está en otra llamada' : result.incoming ? 'Llamada rechazada' : 'No puede atender ahora'}}</h2>
        <p>{{result.replied ? 'Tu mensaje se enviará cuando haya conexión.' : result.incoming ? 'Puedes responder por mensaje o devolver la llamada.' : 'Puedes escribirle o volver a intentarlo cuando prefieras.'}}</p>
        @if(!result.replied){
          <div class="result-actions">
            <button type="button" (click)="calls.messageLastCaller()"><ion-icon name="chatbubble-outline" />Mensaje</button>
            <button class="redial" type="button" (click)="calls.redialLast()"><ion-icon [name]="result.call.type === 'Video' ? 'videocam-outline' : 'call-outline'" />{{result.incoming ? 'Devolver' : 'Volver a llamar'}}</button>
          </div>
        }
        @if(expanded()){<button class="close-result" type="button" (click)="calls.dismissCallResult()">Cerrar</button>}
      </aside>
    }`,
  styles: [`
    :host{position:fixed;z-index:48;inset:auto 12px calc(84px + env(safe-area-inset-bottom));pointer-events:none;display:flex;justify-content:center}
    .call-result{pointer-events:auto;width:min(100%,390px);padding:15px;border:1px solid var(--nivra-line-strong);border-radius:22px;background:var(--nivra-panel-solid);color:var(--nivra-text);box-shadow:var(--nivra-shadow-soft);text-align:start;animation:result-appear .18s ease-out}
    .result-heading{display:flex;align-items:center;gap:10px}.result-avatar{display:grid;place-items:center;width:44px;height:44px;flex:none;border-radius:15px;background:var(--nivra-selection);color:var(--nivra-brand-2);overflow:hidden}.result-avatar img{width:100%;height:100%;object-fit:cover}.result-avatar ion-icon{font-size:23px}.video .result-avatar{color:var(--nivra-blue)}
    .result-copy{min-width:0;flex:1}.result-copy small{display:block;color:var(--nivra-muted);font-size:11px}.result-copy strong{display:block;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}
    h2{font-size:19px;line-height:1.3;margin:12px 0 0}p{color:var(--nivra-muted);line-height:1.45;font-size:12px;margin:6px 0 0}
    button{display:inline-flex;align-items:center;justify-content:center;gap:7px;min-height:44px;border:1px solid var(--nivra-line-strong);border-radius:13px;background:var(--nivra-panel-2);color:var(--nivra-text);font:inherit;font-size:12px;font-weight:650;cursor:pointer}
    .dismiss{width:40px;min-height:40px;flex:none;border:0;background:transparent;color:var(--nivra-muted);font-size:21px}.result-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:13px}.redial{background:var(--nivra-selection);color:var(--nivra-brand-2);border-color:var(--nivra-selection-line)}
    button:focus-visible{outline:2px solid var(--nivra-brand);outline-offset:2px}
    @keyframes result-appear{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    @media(min-width:900px){:host{bottom:24px}}
    @media(prefers-reduced-motion:reduce){.call-result{animation:none}}
    :host.expanded-result{inset:12px 12px calc(80px + env(safe-area-inset-bottom));display:grid;place-items:center;background:var(--nivra-bg);border-radius:24px}
    :host.expanded-result .call-result{width:min(100%,480px);padding:28px;box-shadow:none;text-align:center;background:radial-gradient(ellipse at top,var(--nivra-selection),var(--nivra-panel-solid) 65%)}
    :host.expanded-result .result-heading{flex-direction:column;position:relative}:host.expanded-result .dismiss{position:absolute;right:0;top:0}
    :host.expanded-result .result-avatar{width:104px;height:104px;border-radius:50%}
    :host.expanded-result .result-copy strong{font-size:22px}
    :host.expanded-result h2{font-size:25px;margin-top:26px}
    .close-result{margin-top:12px;width:100%;background:transparent;border:0;color:var(--nivra-muted)}
    @media(min-width:900px){:host.expanded-result{inset:24px auto 24px 50%;width:min(580px,calc(100vw - 130px));transform:translateX(-50%)}}
  `],
})
export class CallResultComponent {
  readonly calls = inject(CallsService);
  private readonly router = inject(Router);
  expanded(): boolean { return this.calls.lastResult()?.incoming === false && this.router.url.split(/[?#]/,1)[0] === '/app/calls'; }
  constructor() { addIcons({callOutline, chatbubbleOutline, closeOutline, videocamOutline}); }
}
