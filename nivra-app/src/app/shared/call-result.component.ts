import { Component, inject } from '@angular/core';
import { CallsService } from '../core/services/calls.service';
import { TransientNoticeDirective } from './transient-notice.directive';

@Component({ selector:'app-call-result', standalone:true, imports:[TransientNoticeDirective], template:`
  @if (calls.lastResult(); as result) {
    <aside class="call-result" [class.video]="result.call.type === 'Video'" role="status" [appTransientNotice]="result.call.id + result.kind" [appNoticeDuration]="12000" (noticeExpired)="calls.lastResult.set(null)">
      <button class="dismiss" type="button" aria-label="Cerrar aviso de llamada" (click)="calls.lastResult.set(null)">×</button>
      <small>{{ result.call.type === 'Video' ? 'VIDEOLLAMADA' : 'LLAMADA DE VOZ' }}</small>
      <strong>{{ result.replied ? 'Respuesta guardada' : result.kind === 'missed' ? (result.incoming ? 'Llamada perdida' : 'No hubo respuesta') : result.kind === 'busy' ? 'Está en otra llamada' : 'No puede atender ahora' }}</strong>
      <p>{{ result.replied ? 'Tu mensaje queda en la cola cifrada y se enviará cuando haya conexión.' : result.kind === 'missed' ? (result.incoming ? 'No pudiste atender. Puedes devolver la llamada.' : 'Puedes volver a intentarlo más tarde o escribir por el chat.') : 'Puedes escribir por el chat o volver a intentarlo más tarde.' }}</p>
      @if (!calls.isGroupCall(result.call) && !result.replied) {
        <button class="redial" type="button" (click)="calls.redialLast()">{{ result.incoming ? 'Devolver llamada' : 'Volver a llamar' }}</button>
      }
    </aside>
  }`, styles:[`
    :host{position:fixed;z-index:48;inset:auto 16px calc(82px + env(safe-area-inset-bottom));pointer-events:none;display:flex;justify-content:center}
    .call-result{position:relative;pointer-events:auto;width:min(100%,420px);padding:20px;border:1px solid var(--nivra-line-strong);border-radius:24px;background:var(--nivra-panel-solid);color:var(--nivra-text);box-shadow:var(--nivra-shadow-soft);text-align:start}
    .call-result small{display:block;color:var(--nivra-brand-2);font-size:10px;font-weight:750;letter-spacing:.12em;padding-inline-end:30px}.video small{color:var(--nivra-blue)}
    strong{display:block;font-size:21px;line-height:1.25;margin-top:8px;padding-inline-end:24px}p{color:var(--nivra-muted);line-height:1.5;font-size:13px;margin:10px 0 0}
    button{font:inherit;cursor:pointer}.dismiss{position:absolute;inset:8px 8px auto auto;width:44px;height:44px;border:0;border-radius:50%;color:var(--nivra-muted);background:transparent;font-size:26px}
    .redial{min-height:44px;margin-top:14px;padding:10px 18px;border:1px solid var(--nivra-line-strong);border-radius:14px;background:var(--nivra-panel-2);color:var(--nivra-brand-2);font-weight:650;font-size:13px}
    button:focus-visible{outline:2px solid var(--nivra-brand);outline-offset:2px}
    @media(min-width:900px){:host{bottom:28px}}
  `] })
export class CallResultComponent { readonly calls=inject(CallsService); }
