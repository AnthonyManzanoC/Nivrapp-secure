import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { Conversation } from '../models/nivra.models';
import { AuthService } from './auth.service';
import { NativeDeviceService } from './native-device.service';
import { AppLockService } from './app-lock.service';

@Injectable({ providedIn: 'root' })
export class PrivacyEnforcementService {
  private readonly auth = inject(AuthService);
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly appLock = inject(AppLockService);
  private readonly activeConversation = signal<Conversation | null>(null);

  readonly screenshotsAllowed = computed(() => {
    if (this.appLock.isEnabled() || this.appLock.isContentLocked()) return false;
    const conversation = this.activeConversation();
    if (!conversation) {
      return true;
    }
    return !this.remoteParticipantBlocksScreenshots(conversation);
  });

  constructor() {
    effect(() => {
      const allowed = this.screenshotsAllowed();
      untracked(() => void this.nativeDevice.setScreenshotsAllowed(allowed));
    });
  }

  setActiveConversation(conversation: Conversation | null): void {
    this.activeConversation.set(conversation);
  }

  clearActiveConversation(conversationId?: string | null): void {
    if (!conversationId || this.activeConversation()?.id === conversationId) {
      this.activeConversation.set(null);
    }
  }

  private remoteParticipantBlocksScreenshots(conversation: Conversation): boolean {
    const currentUserId = this.auth.session()?.user.id;
    if (!currentUserId) {
      return false;
    }
    return conversation.participants
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .some((participant) => participant.privacyPolicy?.allowScreenshots === false);
  }
}
