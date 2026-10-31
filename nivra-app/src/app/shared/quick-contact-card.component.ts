import { Component, EventEmitter, Input, Output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { callOutline, videocamOutline, chatbubbleEllipsesOutline, informationCircleOutline, closeOutline, playCircleOutline } from 'ionicons/icons';
import { TranslatePipe } from '../core/pipes/translate.pipe';
export type QuickContactAction = 'chat' | 'info' | 'Voice' | 'Video' | 'photo' | 'story' | 'close';
@Component({
  selector: 'app-quick-contact-card', standalone: true, imports: [IonIcon, TranslatePipe],
  template: `<section class="quick-contact-card">
    <header><strong>{{ name }}</strong><button type="button" (click)="action.emit('close')" [attr.aria-label]="'COMMON.CLOSE' | translate:'Cerrar'"><ion-icon name="close-outline" /></button></header>
    <button type="button" class="quick-contact-photo" (click)="action.emit('photo')" [attr.aria-label]="'CHAT.VIEW_PROFILE_PHOTO' | translate:'Ver foto de perfil'"><img [src]="photo" alt=""></button>
    <nav [attr.aria-label]="'CHATS.MORE_ACTIONS' | translate:'Más opciones de chats'">
      <button type="button" (click)="action.emit('chat')"><ion-icon name="chatbubble-ellipses-outline" /><span>{{ 'CHAT.TITLE' | translate:'Chat' }}</span></button>
      <button type="button" (click)="action.emit('Voice')"><ion-icon name="call-outline" /><span>{{ 'CALLS.CALL' | translate:'Llamar' }}</span></button>
      <button type="button" (click)="action.emit('Video')"><ion-icon name="videocam-outline" /><span>{{ 'CALLS.VIDEO' | translate:'Video' }}</span></button>
      <button type="button" (click)="action.emit('info')"><ion-icon name="information-circle-outline" /><span>{{ 'CHAT.CONTACT_INFO' | translate:'Información' }}</span></button>
    </nav>
    @if (hasStories) { <button type="button" class="quick-contact-story" (click)="action.emit('story')"><ion-icon name="play-circle-outline" /> {{ 'CHAT.OPEN_STORIES' | translate:'Ver historia' }}</button> }
  </section>`,
  styleUrl: './quick-contact-card.component.scss',
})
export class QuickContactCardComponent {
  @Input() name = '';
  @Input() photo = '';
  @Input() hasStories = false;
  @Output() action = new EventEmitter<QuickContactAction>();
  constructor() { addIcons({ callOutline, videocamOutline, chatbubbleEllipsesOutline, informationCircleOutline, closeOutline, playCircleOutline }); }
}
