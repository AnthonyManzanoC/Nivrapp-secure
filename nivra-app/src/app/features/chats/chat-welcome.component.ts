import { Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowForwardOutline, chatbubbleEllipsesOutline, imageOutline, notificationsOutline, peopleOutline, shareSocialOutline, shieldCheckmarkOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

@Component({
  selector: 'app-chat-welcome',
  standalone: true,
  imports: [IonIcon, TranslatePipe],
  templateUrl: './chat-welcome.component.html',
  styleUrls: ['./chat-welcome.component.scss'],
})
export class ChatWelcomeComponent {
  readonly compact = input(false);
  readonly firstConversation = input(true);
  readonly showCallAlertsSetup = input(false);
  readonly enablingCallAlerts = input(false);
  readonly callAlertsNotice = input('');
  readonly newChat = output<void>();
  readonly sharePass = output<void>();
  readonly newGroup = output<void>();
  readonly newStory = output<void>();
  readonly enableCallAlerts = output<void>();

  constructor() {
    addIcons({ arrowForwardOutline, chatbubbleEllipsesOutline, imageOutline, notificationsOutline, peopleOutline, shareSocialOutline, shieldCheckmarkOutline });
  }
}
