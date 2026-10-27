import { Component, effect, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonModal } from '@ionic/angular/standalone';
import { CallTranslationService, CALL_TRANSLATION_LANGUAGES } from '../core/services/call-translation.service';
import { CallsService } from '../core/services/calls.service';
import { ChatService } from '../core/services/chat.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-call-translation-panel', standalone: true, imports: [FormsModule, IonModal, TranslatePipe],
  template: `
    @if (translation.enabled()) {
    <button class="translation-button" type="button" (click)="open = true" [class.active]="translation.active()"
      [attr.aria-label]="'CALL_TRANSLATION.TITLE' | translate:'Traducir llamada'" [attr.aria-expanded]="open">
      <span aria-hidden="true">文A</span>
    </button>
    }
    @if (translation.active() && translation.hasSubtitles() && translation.caption(); as caption) {
      <aside class="translation-caption" aria-live="polite" aria-atomic="true">
        <small>{{ 'CALL_TRANSLATION.LOCAL' | translate:'Traducción en tu dispositivo' }}</small>
        <p>{{ caption.text || caption.original }}</p>
        @if (!caption.final) { <small>{{ 'CALL_TRANSLATION.LISTENING' | translate:'Escuchando…' }}</small> }
      </aside>
    }
    <ion-modal [isOpen]="open && translation.enabled()" (didDismiss)="open = false" class="call-translation-modal">
      <ng-template>
        <section class="translation-sheet">
          <header>
            <h2>{{ 'CALL_TRANSLATION.TITLE' | translate:'Traducir llamada' }}</h2>
            <button type="button" (click)="open = false" [attr.aria-label]="'COMMON.CLOSE' | translate:'Cerrar'">×</button>
          </header>
          <p>{{ 'CALL_TRANSLATION.COPY' | translate:'Subtítulos, voz traducida o ambos, sólo para ti. El audio original sigue sonando. La voz traducida puede oírse con retraso; usa auriculares para evitar eco.' }}</p>
          <label>{{ 'CALL_TRANSLATION.MODE' | translate:'Cómo quieres traducir' }}
            <select [ngModel]="translation.mode()" (ngModelChange)="configure($event, translation.source(), translation.target())">
              <option value="subtitles">{{ 'CALL_TRANSLATION.SUBTITLES' | translate:'Subtítulos' }}</option>
              <option value="voice">{{ 'CALL_TRANSLATION.VOICE' | translate:'Voz traducida' }}</option>
              <option value="both">{{ 'CALL_TRANSLATION.BOTH' | translate:'Subtítulos y voz' }}</option>
            </select>
          </label>
          <div class="language-pair">
            <label>{{ 'CALL_TRANSLATION.FROM' | translate:'La otra persona habla' }}
              <select [ngModel]="translation.source()" (ngModelChange)="configure(translation.mode(), $event, translation.target())">
                @for (language of languages; track language.code) { <option [value]="language.code">{{ language.label }}</option> }
              </select>
            </label>
            <label>{{ 'CALL_TRANSLATION.TO' | translate:'Quiero entender en' }}
              <select [ngModel]="translation.target()" (ngModelChange)="configure(translation.mode(), translation.source(), $event)">
                @for (language of languages; track language.code) { <option [value]="language.code">{{ language.label }}</option> }
              </select>
            </label>
          </div>
          @if (translation.peers().length > 1) {
            <label>{{ 'CALL_TRANSLATION.PERSON' | translate:'Persona que quieres escuchar' }}
              <select [ngModel]="translation.peerId()" (ngModelChange)="translation.configure(translation.mode(), translation.source(), translation.target(), $event)">
                @for (peer of translation.peers(); track peer[0]) { <option [value]="peer[0]">{{ chat.participantDisplayName(peer[0]) }}</option> }
              </select>
            </label>
          }
          <div class="translation-privacy">
            <strong>{{ 'CALL_TRANSLATION.PRIVACY' | translate:'Procesamiento local' }}</strong>
            <p>{{ 'CALL_TRANSLATION.REQUIREMENTS' | translate:'Requiere Android 13 con un motor de reconocimiento local compatible, o un navegador de escritorio compatible. Al activar puede descargar modelos de idioma; en Android, por Wi-Fi. Audio y subtítulos no se guardan ni se envían a un servicio de traducción. Si falta un motor o una voz local, te avisaremos.' }}</p>
          </div>
          @if (translation.error()) { <p class="translation-error" role="alert">{{ translation.error() }}</p> }
          @if (translation.busy()) {
            <p role="status">{{ 'CALL_TRANSLATION.PREPARING' | translate:'Preparando los idiomas en este dispositivo…' }}</p>
            <button class="translation-start" type="button" (click)="translation.stop()">{{ 'COMMON.CANCEL' | translate:'Cancelar' }}</button>
          } @else if (translation.active()) {
            <p role="status">{{ 'CALL_TRANSLATION.ON' | translate:'Traducción activada para esta llamada' }}</p>
            <button class="translation-start" type="button" (click)="translation.stop()">{{ 'CALL_TRANSLATION.STOP' | translate:'Desactivar traducción' }}</button>
          } @else {
            <button class="translation-start" type="button" [disabled]="!translation.peers().length || calls.phase() !== 'connected'" (click)="translation.start()">{{ 'CALL_TRANSLATION.START' | translate:'Activar en esta llamada' }}</button>
          }
          <small>{{ 'CALL_TRANSLATION.REMEMBER' | translate:'Recordamos tus idiomas y tu modo por cuenta. Tú decides cuándo activarlo en cada llamada. La traducción puede contener errores.' }}</small>
        </section>
      </ng-template>
    </ion-modal>
  `,
  styles: [`
    :host { display: contents; }
    .translation-button { display:grid; place-items:center; flex-shrink:0; width:48px; height:48px; border:1px solid rgba(255,255,255,.14); border-radius:50%; background:rgba(255,255,255,.09); color:#fff; font-size:17px; }
    .translation-button.active { color:#57efc2; border-color:#57efc2; background:#143e35; }
    .translation-button:focus-visible,button:focus-visible,select:focus-visible { outline:2px solid #00a785; outline-offset:3px; }
    .translation-caption { position:fixed; z-index:38; bottom:calc(260px + env(safe-area-inset-bottom)); left:50%; transform:translateX(-50%); width:min(610px,calc(100% - 40px)); max-height:150px; overflow:auto; padding:12px 16px; border:1px solid rgba(255,255,255,.18); border-radius:16px; background:rgba(6,20,18,.93); color:#fff; text-align:center; pointer-events:none; }
    .translation-caption p { margin:5px 0; font-size:clamp(15px,2vw,20px); line-height:1.4; overflow-wrap:anywhere; }
    .translation-caption small { font-size:11px; color:#9ed6c7; }
    ion-modal { --width:min(560px,calc(100vw - 24px)); --height:auto; --max-height:90dvh; --border-radius:24px; --background:var(--nivra-panel-solid,#fff); }
    .translation-sheet { padding:22px; max-height:90dvh; box-sizing:border-box; overflow:auto; color:var(--nivra-text,#142c27); background:var(--nivra-panel-solid,#fff); }
    header { display:flex; align-items:center; justify-content:space-between; gap:12px; }
    h2 { margin:0; font-size:23px; } header button { width:40px; height:40px; border:0; border-radius:50%; background:var(--nivra-input-bg,#f1f5f3); color:inherit; font-size:26px; }
    p,small { line-height:1.5; } .translation-sheet>p { color:var(--nivra-muted,#586e67); font-size:14px; }
    label { display:grid; gap:8px; font-size:13px; font-weight:600; margin:14px 0; min-width:0; }
    select { width:100%; min-height:46px; padding:10px; border:1px solid var(--nivra-line,#d6e3dd); border-radius:12px; color:inherit; background:var(--nivra-input-bg,#f6f9f7); font:inherit; }
    .language-pair { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .translation-privacy { padding:14px; border-radius:14px; background:rgba(0,170,128,.08); font-size:13px; }
    .translation-privacy p { margin:6px 0 0; } .translation-error { color:var(--ion-color-danger,#b42318)!important; }
    .translation-start { width:100%; min-height:48px; margin:14px 0; padding:12px; border:0; border-radius:14px; background:#00b98d; color:#062c23; font-size:15px; font-weight:700; }
    .translation-start:disabled { opacity:.45; } .translation-sheet>small { display:block; color:var(--nivra-muted,#586e67); font-size:12px; }
    @media(min-width:1000px) { .translation-caption { bottom:180px; } }
    @media(max-height:500px) { .translation-caption { bottom:135px; max-height:85px; } }
  `],
})
export class CallTranslationPanelComponent {
  readonly translation = inject(CallTranslationService);
  readonly calls = inject(CallsService);
  readonly chat = inject(ChatService);
  readonly languages = CALL_TRANSLATION_LANGUAGES;
  open = false;
  constructor() {
    effect(() => { if (!this.translation.enabled()) this.open = false; });
  }
  configure(mode: string, source: string, target: string): void { this.translation.configure(mode, source, target); }
}
