import { Component, EventEmitter, Input, Output } from '@angular/core';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({
  selector: 'app-failed-text-send', standalone: true, imports: [TranslatePipe],
  template: `<section [attr.aria-label]="'CHAT.TEXT_NOT_SENT' | translate:'Mensaje sin enviar'">
    <div class="copy">
      <strong role="status">{{ 'CHAT.TEXT_NOT_SENT' | translate:'Mensaje sin enviar' }}</strong>
      <p class="message" dir="auto">{{ text }}</p>
      <p class="hint">{{ 'CHAT.TEXT_RETRY_HINT' | translate:'Reintenta o descarta este mensaje para continuar. El texto nuevo que escribiste se conserva.' }}</p>
    </div>
    <div class="actions">
      <button type="button" class="retry" [disabled]="retryDisabled" (click)="retry.emit()">{{ 'COMMON.RETRY' | translate:'Reintentar' }}</button>
      <button type="button" [disabled]="busy" (click)="discard.emit()">{{ 'CHAT.DISCARD_FAILED_TEXT' | translate:'Descartar mensaje' }}</button>
    </div>
  </section>`,
  styles: [`:host{display:block}section{display:flex;align-items:center;gap:12px;margin:8px 12px;padding:12px 14px;border:1px solid color-mix(in srgb,var(--nivra-brand) 32%,var(--nivra-line));border-radius:16px;background:var(--nivra-panel-solid);color:var(--nivra-text)}
    .copy{flex:1;min-width:0}strong{font-size:13px}.message{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:14px;line-height:1.4}.hint{margin:0;font-size:12px;line-height:1.5;color:var(--nivra-muted)}
    .actions{display:flex;flex-wrap:wrap;gap:4px}button{min-height:44px;padding:8px 12px;border:0;border-radius:12px;background:transparent;color:var(--nivra-muted);font:inherit;font-size:13px;font-weight:600;cursor:pointer}.retry{background:color-mix(in srgb,var(--nivra-brand) 12%,var(--nivra-panel-solid));color:var(--nivra-brand-2)}button:focus-visible{outline:3px solid var(--nivra-brand);outline-offset:2px}button:disabled{opacity:.5;cursor:default}
    @media(max-width:680px){section{align-items:stretch;flex-direction:column;gap:6px}.actions{justify-content:flex-end}}`],
})
export class FailedTextSendComponent {
  @Input() text = '';
  @Input() retryDisabled = false;
  @Input() busy = false;
  @Output() retry = new EventEmitter<void>();
  @Output() discard = new EventEmitter<void>();
}
