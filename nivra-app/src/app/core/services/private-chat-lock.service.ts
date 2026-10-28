import { DestroyRef, Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { NavigationStart, Router } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { fromEvent } from 'rxjs';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { readPrivateChatLocks, writePrivateChatLocks } from './private-chat-lock-metadata';

export type PrivateChatAction = 'unlock' | 'protect' | 'remove';

/** A local privacy gate, separate from blocking a contact or account E2EE keys. */
@Injectable({ providedIn: 'root' })
export class PrivateChatLockService {
  private readonly auth = inject(AuthService);
  private readonly injector = inject(Injector);
  private appLockInstance?: AppLockService;
  get appLock(): AppLockService { return this.appLockInstance ??= this.injector.get(AppLockService); }
  private watchingNavigation = false;
  private readonly destroyRef = inject(DestroyRef);
  private readonly records = new Map<string, readonly string[]>();
  private readonly revision = signal(0);
  private readonly grant = signal<{ scope: string; id: string } | null>(null);
  private observedScope = '';
  private operation = 0;
  private pendingId = '';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly ready = computed(() => this.appLock.isEnabled() && this.appLock.isShared() && !this.appLock.policyPending());
  readonly corruptPolicy = computed(() => this.protectedIdsForUser(this.auth.session()?.user.id ?? '').includes('*'));

  constructor() {
    effect(() => {
      const scope = this.scope();
      const protectedIds = this.protectedIdsForUser(this.auth.session()?.user.id ?? '');
      const appLocked = protectedIds.length > 0 && this.appLock.isContentLocked();
      untracked(() => {
        if (scope !== this.observedScope || appLocked) {
          this.observedScope = scope; this.relock();
        }
      });
    });
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState === 'hidden') this.relock();
    });
    fromEvent<StorageEvent>(window, 'storage').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      // Keep inactive account notification metadata fresh as well.
      if (event.key !== null && !event.key.startsWith('nivra.privateChats.v1:')) return;
      this.records.clear(); this.revision.update(value => value + 1); this.relock();
    });
    this.destroyRef.onDestroy(() => this.relock());
  }

  protectedIdsForUser(userId: string): readonly string[] {
    this.revision();
    if (!userId) return [];
    if (!this.records.has(userId)) this.records.set(userId, readPrivateChatLocks(userId));
    return this.records.get(userId)!;
  }

  isProtected(id: string | null | undefined): boolean {
    if (!id) return false;
    const ids = this.protectedIdsForUser(this.auth.session()?.user.id ?? '');
    return ids.includes('*') || ids.includes(id);
  }

  isLocked(id: string | null | undefined): boolean {
    if (!this.isProtected(id)) return false;
    const grant = this.grant();
    return !this.ready() || this.appLock.isContentLocked() || !grant || grant.scope !== this.scope() || grant.id !== id;
  }

  relock(): void {
    this.operation++; this.pendingId = ''; this.grant.set(null); this.busy.set(false); this.error.set('');
    this.appLockInstance?.cancelProtectedActionVerification();
  }

  async authenticate(id: string, action: PrivateChatAction, pin?: string, biometric = false): Promise<boolean> {
    if (!id || id.length > 128 || this.busy() || !this.ready() || this.appLock.isContentLocked()) return false;
    if (this.corruptPolicy()) { this.error.set('No se pudo leer la configuración de chats protegidos. No se mostrará su contenido.'); return false; }
    const scope = this.scope(), userId = this.auth.session()!.user.id, operation = ++this.operation;
    this.pendingId = id;
    this.watchNavigation();
    this.busy.set(true); this.error.set('');
    const current = () => operation === this.operation && scope === this.scope() && this.ready() && !this.appLock.isContentLocked();
    try {
      const valid = biometric ? await this.appLock.verifyProtectedActionWithBiometrics('Abrir chat protegido')
        : await this.appLock.verifyProtectedAction(pin);
      if (!current()) return false;
      if (!valid) { this.error.set(this.appLock.unlockError() || 'No se pudo verificar el acceso.'); return false; }
      if (action !== 'unlock') {
        // Re-read before writing so a second tab's newly protected chat survives.
        const stored = readPrivateChatLocks(userId);
        if (stored.includes('*')) throw new Error('No se pudo leer la configuración de chats protegidos.');
        const next = action === 'protect' ? [...new Set([...stored, id])] : stored.filter(item => item !== id);
        writePrivateChatLocks(userId, next);
        this.records.set(userId, next); this.revision.update(value => value + 1);
      }
      if (!current()) return false;
      this.grant.set({ scope, id });
      return true;
    } catch (error) {
      if (current()) this.error.set(error instanceof Error ? error.message : 'No se pudo proteger la conversación.');
      return false;
    } finally { if (operation === this.operation) { this.pendingId = ''; this.busy.set(false); } }
  }

  configure(): void { this.relock(); void this.injector.get(Router).navigate(['/app/account']); }
  private watchNavigation(): void {
    if (this.watchingNavigation) return;
    const router = this.injector.get(Router, null);
    if (!router) return;
    this.watchingNavigation = true;
    router.events.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (!(event instanceof NavigationStart)) return;
      const id = this.pendingId || this.grant()?.id;
      if (id && event.url.split(/[?#]/)[0] !== `/app/chats/${encodeURIComponent(id)}`) this.relock();
    });
  }
  private scope(): string {
    const session = this.auth.session();
    return session ? JSON.stringify([session.user.id, session.device?.id ?? '', this.auth.sessionGeneration?.() ?? 0]) : '';
  }
}
