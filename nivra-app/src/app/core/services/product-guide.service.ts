import { Injectable, signal } from '@angular/core';

export interface GuideProgress { introduced: boolean; completed: string[]; }
const EMPTY = (): GuideProgress => ({ introduced: false, completed: [] });
const TASKS = ['account', 'contact', 'message', 'call', 'recovery'];

/** Local learning preferences only; never stores passwords, keys or messages. */
@Injectable({ providedIn: 'root' })
export class ProductGuideService {
  private readonly memory = new Map<string, GuideProgress>();
  readonly revision = signal(0);

  progress(userId: string): GuideProgress {
    this.revision();
    if (!userId) return EMPTY();
    if (this.memory.has(userId)) return this.memory.get(userId)!;
    try {
      const value = JSON.parse(localStorage.getItem(this.key(userId)) || 'null');
      const result = { introduced: value?.introduced === true,
        completed: Array.isArray(value?.completed) ? [...new Set<string>(value.completed.filter((id: unknown) => typeof id === 'string' && TASKS.includes(id)))] : [] };
      this.memory.set(userId, result);
      return result;
    } catch { return EMPTY(); }
  }

  introduce(userId: string): void { this.save(userId, { ...this.progress(userId), introduced: true }); }
  toggle(userId: string, task: string): void {
    if (!TASKS.includes(task)) return;
    const state = this.progress(userId);
    this.save(userId, { ...state, completed: state.completed.includes(task) ? state.completed.filter(id => id !== task) : [...state.completed, task] });
  }
  private key(userId: string): string { return `nivra.guide.v1.${encodeURIComponent(userId)}`; }
  private save(userId: string, value: GuideProgress): void {
    if (!userId) return;
    this.memory.set(userId, value);
    try { localStorage.setItem(this.key(userId), JSON.stringify(value)); } catch { /* Usable for this session when storage is unavailable. */ }
    this.revision.update(value => value + 1);
  }
}
