import { Component, Input } from '@angular/core';
import { TranslatePipe } from '../core/pipes/translate.pipe';

/** Decorative silhouettes only. The caller owns real loading/readiness and keeps readable data visible. */
@Component({
  selector: 'app-chat-loading',
  standalone: true,
  imports: [TranslatePipe],
  template: `<div class="chat-loading" [class.compact]="compact" [class.single]="single" [class.message-loading]="mode === 'messages'" [attr.role]="single ? 'presentation' : 'status'" [attr.aria-live]="single ? 'off' : 'polite'" [attr.aria-hidden]="single ? 'true' : null" aria-atomic="true">
    @if (compact) {
      <span class="loading-indicator" aria-hidden="true"></span>
      <span>{{ (mode === 'messages' ? 'HISTORY_LOADING.UPDATING_MESSAGES' : 'HISTORY_LOADING.UPDATING_CHATS') | translate:(mode === 'messages' ? 'Actualizando mensajes' : 'Actualizando tus chats') }}</span>
    } @else {
      @if (!single) { <span class="loading-description">{{ (mode === 'messages' ? 'HISTORY_LOADING.MESSAGES' : 'HISTORY_LOADING.CHATS') | translate:(mode === 'messages' ? 'Preparando tus mensajes' : 'Preparando tus conversaciones') }}</span> }
      <div class="loading-silhouettes" aria-hidden="true">
        @for (row of (single ? singleRow : rows); track row) {
          <div class="loading-row" [class.outgoing]="mode === 'messages' && (row === 1 || row === 4)">
            @if (mode === 'conversations') { <span class="loading-avatar"></span> }
            <span class="loading-copy"><i></i><i></i>@if (mode === 'messages' && row === 2) { <i></i> }</span>
            @if (mode === 'conversations') { <span class="loading-time"></span> }
          </div>
        }
      </div>
    }
  </div>`,
  styleUrls: ['./chat-loading.component.scss'],
})
export class ChatLoadingComponent {
  @Input() mode: 'conversations' | 'messages' = 'conversations';
  @Input() compact = false;
  @Input() single = false;
  @Input() rowCount = 5;
  get rows(): number[] { return Array.from({ length: Math.max(1, Math.min(12, this.rowCount)) }, (_, index) => index); }
  readonly singleRow = [0];
}
