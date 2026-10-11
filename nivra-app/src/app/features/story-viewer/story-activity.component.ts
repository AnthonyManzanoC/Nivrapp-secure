import { CommonModule } from '@angular/common';
import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { closeOutline, eyeOutline, heartOutline, refreshOutline, chatbubbleOutline } from 'ionicons/icons';
import { Story, StoryComment } from '../../core/models/nivra.models';
import { SocialService } from '../../core/services/social.service';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { Router } from '@angular/router';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
@Component({
  selector: 'app-story-activity', standalone: true,
  imports: [CommonModule, FormsModule, IonIcon, IonSpinner, TranslatePipe, LocalizedDatePipe],
  templateUrl: './story-activity.component.html', styleUrls: ['./story-activity.component.scss'],
})
export class StoryActivityComponent {
  readonly social = inject(SocialService);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  private readonly router = inject(Router);
  @Input({ required: true }) story!: Story;
  @Output() closed = new EventEmitter<void>();
  tab: 'views' | 'reactions' | 'replies' = 'views';
  openingReply = '';
  replyError = false;
  constructor() { addIcons({ closeOutline, eyeOutline, heartOutline, refreshOutline, chatbubbleOutline }); }
  get authorized(): boolean { return this.story.owner.id === this.auth.session()?.user.id; }
  get views(): number { return Math.max(this.story.viewCount || 0, this.story.views?.length || 0); }
  get people() { return [...(this.story.views || [])].sort((a, b) => Date.parse(b.viewedAt) - Date.parse(a.viewedAt)); }
  get reactions() { return [...(this.story.reactions || [])].sort((a, b) => Date.parse(b.reactedAt) - Date.parse(a.reactedAt)); }
  get replies() { return [...(this.story.comments || [])].sort((a, b) => Date.parse(b.commentedAt) - Date.parse(a.commentedAt)); }
  reactionFor(userId: string): string { return this.story.reactions?.find((reaction) => reaction.user.id === userId)?.emoji || ''; }
  async refresh(): Promise<void> { if (this.authorized) await this.social.refreshStoryActivity(this.story).catch(() => undefined); }
  async openReply(comment: StoryComment): Promise<void> {
    if (!this.authorized || this.openingReply) return;
    const scope = this.auth.session();
    this.openingReply = comment.id; this.replyError = false;
    try {
      const conversation = await this.chat.createDirectConversation(comment.user);
      const current = this.auth.session();
      if (scope?.user.id !== current?.user.id || scope?.device.id !== current?.device.id) return;
      this.closed.emit(); this.social.closeStory();
      await this.router.navigate(['/app/chats', conversation.id]);
    } catch { if (scope?.user.id === this.auth.session()?.user.id) this.replyError = true; }
    finally { this.openingReply = ''; }
  }
}
