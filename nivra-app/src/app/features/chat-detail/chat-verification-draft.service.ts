import { Injectable, effect, inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';

interface ChatDraft {
  text: string;
  deleteAfterRead?: boolean;
  ttlSeconds?: number;
}

/** In-memory handoff. Message drafts never enter browser history or storage. */
@Injectable({ providedIn: 'root' })
export class ChatVerificationDraftService {
  private readonly auth = inject(AuthService);
  private savedScope: string | null = null;
  private readonly drafts = new Map<string, ChatDraft>();

  constructor() {
    effect(() => {
      this.syncScope();
    });
  }

  save(conversationId: string, text: string, policy?: Pick<ChatDraft, 'deleteAfterRead' | 'ttlSeconds'>): void {
    if (!this.syncScope() || !conversationId) return;
    if (text) this.drafts.set(conversationId, { text, ...policy });
    else this.drafts.delete(conversationId);
  }

  take(conversationId: string): ChatDraft | null {
    if (!this.syncScope()) return null;
    const draft = this.drafts.get(conversationId) ?? null;
    this.drafts.delete(conversationId);
    return draft;
  }

  discard(conversationId: string): void {
    if (this.syncScope()) this.drafts.delete(conversationId);
  }

  private syncScope(): string | null {
    const current = this.auth.session();
    const scope = current?.user.id && current.device.id
      ? JSON.stringify([current.user.id, current.device.id, this.auth.sessionGeneration?.()])
      : null;
    if (scope !== this.savedScope) {
      this.drafts.clear();
      this.savedScope = scope;
    }
    return scope;
  }
}
