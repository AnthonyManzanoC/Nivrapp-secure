import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonContent, IonFooter, IonIcon, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, eyeOutline, happyOutline, heart, heartOutline, repeatOutline, sendOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { Story, StoryPayload } from '../../core/models/nivra.models';
import { SocialService } from '../../core/services/social.service';

export interface StoryPointerUpEvent {
  event: PointerEvent;
  side: 'left' | 'right';
}

@Component({
  selector: 'app-story-viewer',
  standalone: true,
  imports: [CommonModule, FormsModule, TranslatePipe, IonContent, IonFooter, IonIcon, IonInput, IonSpinner],
  templateUrl: './story-viewer.component.html',
  styleUrls: ['./story-viewer.component.scss'],
})
export class StoryViewerComponent {
  readonly social = inject(SocialService);
  readonly heartEmoji = '\u2764\uFE0F';
  readonly defaultReactionOptions = ['\u2764\uFE0F', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}', '\u{1F525}'];

  @Input({ required: true }) story!: Story;
  @Input({ required: true }) payload!: StoryPayload;
  @Input() queue: Story[] = [];
  @Input() progress: number[] = [];
  @Input() reply = '';
  @Input() busyId = '';
  @Input() reactionsOpen = false;
  @Input() isMine = false;
  @Input() uiHidden = false;
  @Input() subtitle = '';
  @Input() viewsCount = 0;
  @Input() canRepost = true;
  @Input() reactionOptions: string[] = this.defaultReactionOptions;

  @Output() replyChange = new EventEmitter<string>();
  @Output() closeViewer = new EventEmitter<void>();
  @Output() previous = new EventEmitter<void>();
  @Output() next = new EventEmitter<void>();
  @Output() pointerDown = new EventEmitter<PointerEvent>();
  @Output() pointerUp = new EventEmitter<StoryPointerUpEvent>();
  @Output() pointerCancel = new EventEmitter<void>();
  @Output() syncDuration = new EventEmitter<Event>();
  @Output() mediaEnded = new EventEmitter<void>();
  @Output() openStats = new EventEmitter<void>();
  @Output() sendReply = new EventEmitter<void>();
  @Output() react = new EventEmitter<string>();
  @Output() toggleReactions = new EventEmitter<void>();
  @Output() repost = new EventEmitter<void>();

  constructor() {
    addIcons({ closeOutline, eyeOutline, happyOutline, heart, heartOutline, repeatOutline, sendOutline });
  }

  progressFor(index: number): number {
    return this.progress[index] ?? 0;
  }

  onReplyChange(value: string | number | null | undefined): void {
    this.replyChange.emit(String(value ?? ''));
  }

  retryMedia(): void {
    void this.social.ensureStoryMedia(this.story).catch(() => undefined);
  }
}
