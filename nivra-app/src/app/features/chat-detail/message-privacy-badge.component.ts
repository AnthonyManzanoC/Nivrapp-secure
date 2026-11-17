import { Component, computed, input } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { timerOutline } from 'ionicons/icons';
import { ChatMessageVm } from '../../core/models/nivra.models';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

/** Exact dates stay meaningful without a timer for every message in the thread. */
@Component({
  selector: 'app-message-privacy-badge', standalone: true,
  imports: [IonIcon, LocalizedDatePipe, TranslatePipe],
  template: `
    @if (expiresAt(); as at) {
      <span class="privacy-marker expiry" [title]="('CHAT.EXPIRES_AT' | translate:'Caduca el') + ' ' + (at | localizedDate:'medium')">
        <ion-icon name="timer-outline" aria-hidden="true" />
        <span>{{ 'CHAT.EXPIRES_AT' | translate:'Caduca el' }} <time [attr.datetime]="at">{{ at | localizedDate:'short' }}</time></span>
      </span>
    }
    @if (viewOnce()) {
      <span class="privacy-marker once"><b aria-hidden="true">1</b><span>{{ (opened() ? 'CHAT.VIEW_ONCE_OPENED_SHORT' : 'CHAT.VIEW_ONCE') | translate:(opened() ? 'Abierto' : 'Ver una vez') }}</span></span>
    }
  `,
  styles: [`:host{display:flex;flex-wrap:wrap;align-items:center;gap:5px;font-size:10px;line-height:1.4}
    :host:empty{display:none}.privacy-marker{display:inline-flex;align-items:center;gap:4px;max-width:100%;padding:3px 6px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:7px;background:color-mix(in srgb,currentColor 5%,transparent)}
    ion-icon{flex-shrink:0;font-size:13px}.once b{display:grid;place-items:center;width:13px;height:13px;border:1px solid currentColor;border-radius:50%;font-size:9px;font-weight:650}time{white-space:nowrap}`],
})
export class MessagePrivacyBadgeComponent {
  readonly message = input<ChatMessageVm | null>(null);
  readonly expiresAt = computed(() => {
    const value = this.message()?.expiresAt;
    return value && Number.isFinite(Date.parse(value)) ? value : null;
  });
  readonly opened = computed(() => this.message()?.payload.type === 'view-once-opened' || this.message()?.payload.event === 'view_once_opened');
  readonly viewOnce = computed(() => !!this.message()?.deleteAfterRead || this.opened());
  constructor() { addIcons({ timerOutline }); }
}
