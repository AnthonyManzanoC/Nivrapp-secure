import { Injectable, InjectionToken, inject, signal } from '@angular/core';

interface PromptState { attempted: boolean; remindAfter: number; }
export interface NotificationPromptRuntime {
  now(): number;
  read(): string | null;
  write(value: string): void;
}
const KEY = 'nivra.notifications.native-prompt.v1';
export const NOTIFICATION_PROMPT_RUNTIME = new InjectionToken<NotificationPromptRuntime>('NOTIFICATION_PROMPT_RUNTIME', {
  providedIn: 'root', factory: () => ({ now: () => Date.now(),
    read: () => localStorage.getItem(KEY), write: value => localStorage.setItem(KEY, value) }),
});

/** One contextual system prompt per installation; reminders remain dismissible. */
@Injectable({ providedIn: 'root' })
export class NotificationPermissionPromptService {
  private readonly runtime = inject(NOTIFICATION_PROMPT_RUNTIME);
  private readonly state = signal<PromptState>(this.read());

  showReminder(): boolean { return this.runtime.now() >= this.state().remindAfter; }
  claimAutomaticPrompt(): boolean {
    if (this.state().attempted || !this.showReminder()) return false;
    this.save({ ...this.state(), attempted: true });
    return true;
  }
  markAttempted(): void { this.save({ ...this.state(), attempted: true }); }
  remindTomorrow(): void { this.save({ ...this.state(), remindAfter: this.runtime.now() + 86_400_000 }); }

  private read(): PromptState {
    try {
      const value = JSON.parse(this.runtime.read() || 'null');
      if (value && typeof value.attempted === 'boolean' && Number.isFinite(value.remindAfter) && value.remindAfter >= 0) {
        // A clock error or malformed state must not silence the reminder forever.
        return { attempted: value.attempted, remindAfter: Math.min(value.remindAfter, this.runtime.now() + 86_400_000) };
      }
    } catch { /* The in-memory policy still prevents repeated prompts. */ }
    return { attempted: false, remindAfter: 0 };
  }
  private save(value: PromptState): void {
    this.state.set(value);
    try { this.runtime.write(JSON.stringify(value)); } catch { /* Usable when browser storage is denied. */ }
  }
}
