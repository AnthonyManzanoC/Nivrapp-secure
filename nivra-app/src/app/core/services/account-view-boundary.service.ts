import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';

/** Detach retained routes for one render when the account/device identity changes. */
@Injectable({ providedIn: 'root' })
export class AccountViewBoundaryService {
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly paintedScope = signal<string | null>(this.scope());
  private observedScope = this.scope();
  private frame: number | null = null;
  // This comparison becomes false synchronously on session.set(), before
  // service effects or a delayed request can update the retained old page.
  readonly ready = computed(() => this.paintedScope() === this.scope());

  constructor() {
    effect(() => {
      const scope = this.scope();
      untracked(() => {
        if (scope === this.observedScope) return;
        this.observedScope = scope;
        this.paintedScope.set(null);
        if (this.frame !== null) cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => {
          this.frame = null;
          if (this.scope() === scope) this.paintedScope.set(scope);
        });
      });
    });
    this.destroyRef.onDestroy(() => { if (this.frame !== null) cancelAnimationFrame(this.frame); });
  }

  private scope(): string {
    const session = this.auth.session();
    return session ? `${session.user.id}:${session.device.id}` : 'signed-out';
  }
}
