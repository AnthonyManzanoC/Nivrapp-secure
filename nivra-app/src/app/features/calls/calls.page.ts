import { CommonModule, DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { IonButton, IonContent, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  callOutline,
  closeOutline,
  enterOutline,
  micOffOutline,
  micOutline,
  phonePortraitOutline,
  videocamOffOutline,
  videocamOutline,
  volumeHighOutline,
  volumeMuteOutline,
} from 'ionicons/icons';
import { CallsService } from '../../core/services/calls.service';
import { ChatService } from '../../core/services/chat.service';
import { MediaStreamDirective } from '../../shared/media-stream.directive';

@Component({
  selector: 'app-calls',
  standalone: true,
  imports: [CommonModule, DatePipe, IonButton, IonContent, IonIcon, MediaStreamDirective],
  templateUrl: './calls.page.html',
  styleUrls: ['./calls.page.scss'],
})
export class CallsPage {
  readonly calls = inject(CallsService);
  readonly chat = inject(ChatService);

  constructor() {
    addIcons({
      callOutline,
      closeOutline,
      enterOutline,
      micOffOutline,
      micOutline,
      phonePortraitOutline,
      videocamOffOutline,
      videocamOutline,
      volumeHighOutline,
      volumeMuteOutline,
    });
  }

  async startSelected(type: 'Voice' | 'Video'): Promise<void> {
    const conversation = this.chat.selectedConversation();
    if (!conversation) {
      return;
    }
    await this.calls.start(type, conversation.id, []);
  }

  async accept(): Promise<void> {
    await this.calls.accept();
  }

  async decline(): Promise<void> {
    await this.calls.decline();
  }

  async endActive(): Promise<void> {
    await this.calls.end();
  }

  async rejoin(callId: string): Promise<void> {
    await this.calls.rejoin(callId);
  }

  canRejoin(callId: string): boolean {
    return !this.calls.activeCall() && Boolean(callId);
  }

  selectedTitle(): string {
    const conversation = this.chat.selectedConversation();
    return conversation ? this.chat.conversationTitle(conversation) : 'Selecciona un chat';
  }
}
