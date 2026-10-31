import { Component, computed, inject, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkDoneOutline, checkmarkOutline, closeOutline, timeOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { ChatMessageVm, Participant } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { TranslateService } from '../../core/services/translate.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { recipientReceipts, ReceiptState } from './message-receipts';

@Component({
  selector: 'app-message-info-content', standalone: true,
  imports: [IonIcon, TranslatePipe, LocalizedDatePipe],
  templateUrl: './message-info-content.component.html', styleUrls: ['./message-info-content.component.scss'],
})
export class MessageInfoContentComponent {
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly translate = inject(TranslateService);
  readonly message = input<ChatMessageVm | null>(null);
  readonly participants = input<readonly Participant[]>([]);
  readonly close = output<void>();
  readonly current = computed(() => {
    const message = this.message(), owner = this.auth.session()?.user.id;
    return owner && message?.mine && message.senderUserId === owner ? message : null;
  });
  readonly rows = computed(() => {
    const message = this.current();
    return message ? recipientReceipts(message, message.senderUserId, this.participants()) : [];
  });
  readonly readCount = computed(() => this.rows().filter(row => row.state === 'read').length);
  readonly deliveredCount = computed(() => this.rows().filter(row => row.state !== 'pending').length);
  readonly groups = computed(() => (['read', 'delivered', 'pending'] as ReceiptState[]).map(state => ({
    state, rows: this.rows().filter(row => row.state === state).sort((a, b) => this.name(a.userId).localeCompare(this.name(b.userId))),
  })).filter(group => group.rows.length > 0));
  name(userId: string): string {
    return this.chat.participantDisplayName(userId) || this.participants().find(person => person.userId === userId)?.displayName || this.translate.instant('COMMON.SOMEONE', 'Alguien');
  }
  photo(userId: string): string { return this.chat.participantPhoto(userId) || ''; }
  initials(userId: string): string { return this.name(userId).trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0] || '').join('').toLocaleUpperCase(); }
  constructor() { addIcons({ checkmarkDoneOutline, checkmarkOutline, closeOutline, timeOutline, shieldCheckmarkOutline }); }
}
