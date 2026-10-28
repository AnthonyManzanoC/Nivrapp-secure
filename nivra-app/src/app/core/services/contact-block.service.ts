import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom, timeout } from 'rxjs';
import { AuthService } from './auth.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

@Injectable({ providedIn: 'root' })
export class ContactBlockService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly state = signal<{ owner: string; ids: string[] }>({ owner: '', ids: [] });
  private scope = '';
  private revision = 0;
  private refreshing: { scope: string; task: Promise<void> } | null = null;
  private refreshAgain = false;
  private writing: { scope: string; task: Promise<void> } | null = null;
  readonly blockedUserIds = computed(() => {
    const owner = this.auth.session()?.user.id ?? '';
    return this.state().owner === owner ? this.state().ids : owner ? this.cached(owner) : [];
  });

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const scope = session ? `${this.auth.sessionGeneration?.() ?? 0}:${session.user.id}:${session.device.id}` : '';
      untracked(() => {
        if (scope === this.scope) return;
        this.scope = scope;
        this.revision++;
        this.state.set({ owner: session?.user.id ?? '', ids: session ? this.cached(session.user.id) : [] });
        if (scope) void this.refresh().catch(() => undefined);
      });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['contacts.blocksChanged', 'connected', 'reconnected'].includes(event.type)) void this.refresh().catch(() => undefined);
    });
  }

  isBlocked(userId: string | null | undefined): boolean {
    return !!userId && this.blockedUserIds().includes(userId);
  }

  async refresh(): Promise<void> {
    const session = this.auth.session();
    if (!session) return;
    const scope = `${this.auth.sessionGeneration?.() ?? 0}:${session.user.id}:${session.device.id}`;
    if (this.refreshing?.scope === scope) { this.refreshAgain = true; return this.refreshing.task; }
    const revision = this.revision;
    const task = firstValueFrom(this.api.get<string[]>('/contacts/blocks').pipe(timeout(20_000))).then(ids => {
      if (!this.current(scope) || this.revision !== revision) return;
      if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string' && id.length <= 64)) throw new Error('Respuesta de bloqueo no válida.');
      this.apply(session.user.id, ids);
    }).finally(() => {
      if (this.refreshing?.task !== task) return;
      this.refreshing = null;
      if (this.refreshAgain && this.current(scope)) {
        this.refreshAgain = false;
        void this.refresh().catch(() => undefined);
      }
    });
    this.refreshing = { scope, task };
    return task;
  }

  setBlocked(userId: string, blocked: boolean): Promise<void> {
    const session = this.auth.session();
    if (!session || !userId || userId === session.user.id) return Promise.reject(new Error('Selecciona otro contacto.'));
    const scope = `${this.auth.sessionGeneration?.() ?? 0}:${session.user.id}:${session.device.id}`;
    const previous = this.writing?.scope === scope ? this.writing.task.catch(() => undefined) : Promise.resolve();
    const task = previous.then(() => this.write(scope, session.user.id, userId, blocked));
    this.writing = { scope, task };
    return task;
  }

  private async write(scope: string, owner: string, userId: string, blocked: boolean): Promise<void> {
    if (!this.current(scope)) throw new Error('La cuenta cambió. Vuelve al chat para revisar el bloqueo.');
    ++this.revision;
    const response = await firstValueFrom(this.api.put<{ userId: string; blocked: boolean }>(`/contacts/${encodeURIComponent(userId)}/block`, { blocked }).pipe(timeout(20_000)));
    if (!this.current(scope)) throw new Error('La cuenta cambió. Vuelve al chat para revisar el bloqueo.');
    if (response.userId !== userId || response.blocked !== blocked) throw new Error('No se pudo confirmar el bloqueo. Reintenta.');
    const ids = new Set(this.blockedUserIds());
    blocked ? ids.add(userId) : ids.delete(userId);
    this.apply(owner, [...ids]);
  }

  private current(scope: string): boolean {
    const current = this.auth.session();
    return !!current && `${this.auth.sessionGeneration?.() ?? 0}:${current.user.id}:${current.device.id}` === scope;
  }

  private apply(owner: string, ids: string[]): void {
    const unique = [...new Set(ids)];
    this.state.set({ owner, ids: unique });
    try { localStorage.setItem(`nivra.contactBlocks.v1.${owner}`, JSON.stringify(unique)); } catch { /* Server remains authoritative when storage is full. */ }
  }

  private cached(owner: string): string[] {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`nivra.contactBlocks.v1.${owner}`) ?? '[]');
      return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length <= 64) : [];
    } catch { return []; }
  }
}
