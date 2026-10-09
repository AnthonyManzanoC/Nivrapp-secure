import { Injectable, effect, inject } from '@angular/core';
import { AuthService } from '../../core/services/auth.service';

/** A one-use handoff in memory. Message drafts never enter browser history or storage. */
@Injectable({ providedIn: 'root' })
export class ChatVerificationDraftService {
  private readonly auth = inject(AuthService);
  private saved: { scope: string; conversationId: string; text: string } | null = null;

  constructor() {
    effect(() => {
      const scope = this.scope();
      if (this.saved && this.saved.scope !== scope) this.saved = null;
    });
  }

  save(conversationId: string, text: string): void {
    const scope = this.scope();
    this.saved = scope && conversationId && text ? { scope, conversationId, text } : null;
  }

  take(conversationId: string): string | null {
    const scope = this.scope();
    if (!this.saved || this.saved.scope !== scope) {
      this.saved = null;
      return null;
    }
    if (this.saved.conversationId !== conversationId) return null;
    const text = this.saved.text;
    this.saved = null;
    return text;
  }

  discard(conversationId: string): void {
    if (this.saved?.scope === this.scope() && this.saved.conversationId === conversationId) this.saved = null;
  }

  private scope(): string | null {
    const current = this.auth.session();
    return current?.user.id && current.device.id ? JSON.stringify([current.user.id, current.device.id]) : null;
  }
}
