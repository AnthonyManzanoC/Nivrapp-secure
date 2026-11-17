import { Component, DestroyRef, NgZone, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { IonIcon } from '@ionic/angular/standalone';
import { CallsService } from '../core/services/calls.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

export function globalCallReturnVisible(context: { url: string; authenticated: boolean; locked: boolean; active: boolean; phase: string }): boolean {
  return context.authenticated && !context.locked && context.active && !['idle', 'ringing'].includes(context.phase)
    && !/^\/app(?:\/|[?#]|$)/.test(context.url);
}

/** One return surface shared by the shell and routes outside it. */
@Component({
  selector: 'app-call-return-bar', standalone: true, imports: [IonIcon, TranslatePipe],
  template: `
    <aside class="call-return-bar" [attr.aria-label]="'CALLS.RETURN_TO_CALL' | translate:'Volver a la llamada'">
      <button type="button" class="return-action" (click)="open()">
        <span class="call-symbol"><ion-icon [name]="calls.activeCall()?.type === 'Video' ? 'videocam-outline' : 'call-outline'" aria-hidden="true" /></span>
        <span class="copy"><strong>{{ calls.callTitle(calls.activeCall() || calls.resumableCall()) }}</strong>
          @if (calls.activeCall(); as call) {<small>{{ calls.callStatusLabel(call) }} · {{ elapsed() }}</small>}
          @else {<small>{{ 'CALLS.RETURN_TO_CALL' | translate:'Volver a la llamada' }}</small>}
        </span>
        <span class="return-label">{{ 'COMMON.BACK' | translate:'Volver' }} <span aria-hidden="true">→</span></span>
      </button>
      @if (calls.activeCall() && calls.audioOutput.playbackBlocked()) {
        <button type="button" class="resume-audio" (click)="calls.audioOutput.resume()">{{ 'CALLS.ENABLE_AUDIO' | translate:'Activar audio' }}</button>
      }
    </aside>`,
  styles: [`
    :host{display:block;min-width:0}
    :host(.floating){position:fixed;z-index:14;inset:max(12px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) auto max(12px,env(safe-area-inset-left));max-width:560px;margin-inline:auto}
    .call-return-bar{display:flex;align-items:center;gap:10px;min-height:58px;padding:8px 16px;border-bottom:1px solid var(--nivra-line);background:color-mix(in srgb,var(--nivra-brand) 9%,var(--nivra-panel-solid));color:var(--nivra-text);box-sizing:border-box}
    :host(.floating) .call-return-bar{border:1px solid var(--nivra-line);border-radius:16px;box-shadow:var(--nivra-shadow-soft)}
    button{font:inherit;cursor:pointer;color:inherit;border:0}
    .return-action{display:flex;align-items:center;gap:12px;min-width:0;min-height:42px;flex:1;background:transparent;padding:0;text-align:start}
    .call-symbol{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;flex:none;background:var(--nivra-selection);color:var(--nivra-brand-2)}
    ion-icon{font-size:21px}.copy{display:grid;gap:3px;min-width:0}.copy strong,.copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    strong{font-size:13px;font-weight:650}small{font-size:11px;color:var(--nivra-muted)}
    .return-label{margin-inline-start:auto;font-size:12px;color:var(--nivra-brand-2);white-space:nowrap}.resume-audio{border:1px solid var(--nivra-selection-line);border-radius:10px;min-height:40px;padding:7px 10px;background:var(--nivra-panel-solid);font-size:12px}
    button:focus-visible{outline:2px solid var(--nivra-brand-2);outline-offset:3px}
    @media(max-width:768px){.call-return-bar{padding:max(8px,env(safe-area-inset-top)) max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left))}:host(.floating) .call-return-bar{padding-top:8px}.return-label{font-size:11px}.return-action{gap:9px}}
  `],
})
export class CallReturnBarComponent {
  readonly calls = inject(CallsService);
  private readonly router = inject(Router);
  private readonly now = signal(Date.now());
  readonly elapsed = computed(() => {
    const started = Date.parse(this.calls.activeCall()?.startedAt || '');
    const seconds = Number.isFinite(started) ? Math.max(0, Math.floor((this.now() - started) / 1000)) : 0;
    const clock = `${Math.floor(seconds % 3600 / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`;
    return seconds >= 3600 ? `${Math.floor(seconds / 3600)}:${clock}` : clock;
  });
  constructor() {
    const timer = inject(NgZone).runOutsideAngular(() => window.setInterval(() => {
      if (document.visibilityState !== 'hidden') this.now.set(Date.now());
    }, 1000));
    inject(DestroyRef).onDestroy(() => window.clearInterval(timer));
  }
  open(): void { void this.router.navigate(['/app/calls']); }
}
