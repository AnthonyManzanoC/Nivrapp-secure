import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { firstValueFrom } from 'rxjs';
import {
  Entitlements,
  NivraDevice,
  NivraUser,
  PatchProfileRequest,
  PrivacySettings,
} from '../models/nivra.models';
import { AuthService } from './auth.service';
import { CryptoService } from './crypto.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
  private readonly crypto = inject(CryptoService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);

  readonly devices = signal<NivraDevice[]>([]);
  readonly privacy = signal<PrivacySettings | null>(null);
  readonly entitlements = signal<Entitlements | null>(null);
  readonly loading = signal(false);
  private loadInFlight: { scope: string; promise: Promise<void> } | null = null;
  private scopeRevision = 0;
  private observedScope = this.currentScope();

  constructor() {
    effect(() => {
      this.observeScope(this.currentScope());
    });
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event.type === 'device.listChanged' && this.auth.isAuthenticated()) {
          void this.load().catch(() => undefined);
        }
        if (
          event.type === 'profile.updated' &&
          this.auth.isAuthenticated() &&
          String((event.payload as { userId?: unknown })?.userId || '') === this.auth.session()?.user.id
        ) {
          void this.load().catch(() => undefined);
        }
      });
  }

  load(): Promise<void> {
    const scope = this.currentScope();
    this.observeScope(scope);
    if (!scope || !this.auth.isAuthenticated()) return Promise.resolve();
    if (this.loadInFlight?.scope === scope) return this.loadInFlight.promise;
    const revision = this.scopeRevision;
    const promise = this.loadForScope(scope, revision);
    this.loadInFlight = { scope, promise };
    void promise.finally(() => {
      if (this.loadInFlight?.promise === promise) this.loadInFlight = null;
    }).catch(() => undefined);
    return promise;
  }

  private async loadForScope(scope: string, revision: number): Promise<void> {
    this.loading.set(true);
    try {
      const [me, devices, privacy, entitlements] = await Promise.all([
        firstValueFrom(this.api.get<NivraUser>('/me')),
        firstValueFrom(this.api.get<NivraDevice[]>('/devices')),
        firstValueFrom(this.api.get<PrivacySettings>('/privacy')),
        firstValueFrom(this.api.get<Entitlements>('/monetization/entitlements')).catch(() => null),
      ]);
      if (!this.isCurrent(scope, revision) || me.id !== this.auth.session()?.user.id) return;
      this.auth.updateUser(me);
      this.devices.set(devices ?? []);
      this.privacy.set(privacy);
      this.entitlements.set(entitlements);
    } finally {
      if (this.isCurrent(scope, revision)) this.loading.set(false);
    }
  }

  async updateProfile(patch: PatchProfileRequest): Promise<NivraUser> {
    const current = this.auth.session();
    const scope = this.currentScope();
    this.observeScope(scope);
    const revision = this.scopeRevision;
    this.requireCurrent(scope, revision);
    const requestedAlias = this.normalizeAlias(patch.alias);
    const shouldMoveLocalKeys = Boolean(
      current?.device?.id &&
      requestedAlias &&
      requestedAlias !== this.normalizeAlias(current.user.alias),
    );
    const currentKeys = shouldMoveLocalKeys && current
      ? await this.crypto.currentKeyMaterial(current.user.alias, current.device.id)
      : null;

    this.requireCurrent(scope, revision);
    const user = await firstValueFrom(this.api.patch<NivraUser>('/me', patch));
    this.requireCurrent(scope, revision);
    if (user.id !== current?.user.id) throw new Error('ACCOUNT_SESSION_CHANGED');
    if (currentKeys && current?.device?.id) {
      await this.crypto.saveDeviceKeys(
        user.alias,
        current.device.id,
        this.crypto.materialToDeviceKeys(currentKeys),
        { userId: user.id },
      );
    }
    this.requireCurrent(scope, revision);
    this.auth.updateUser(user);
    return user;
  }

  async checkAliasAvailable(alias: string): Promise<boolean> {
    const normalizedAlias = this.normalizeAlias(alias);
    if (!normalizedAlias) {
      return false;
    }
    return firstValueFrom(this.api.get<boolean>(`/users/check-alias?alias=${encodeURIComponent(normalizedAlias)}`));
  }

  async updatePrivacy(patch: PrivacySettings): Promise<PrivacySettings> {
    const scope = this.currentScope();
    this.observeScope(scope);
    const revision = this.scopeRevision;
    this.requireCurrent(scope, revision);
    const privacy = await firstValueFrom(this.api.patch<PrivacySettings>('/privacy', patch));
    this.requireCurrent(scope, revision);
    this.privacy.set(privacy);
    const current = this.auth.session();
    if (current) {
      this.auth.updateUser({ ...current.user, privacySettings: privacy });
    }
    return privacy;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    const scope = this.currentScope();
    this.observeScope(scope);
    const revision = this.scopeRevision;
    this.requireCurrent(scope, revision);
    await firstValueFrom(this.api.post(`/devices/${encodeURIComponent(deviceId)}/revoke`, {}));
    this.requireCurrent(scope, revision);
    this.devices.update((devices) => devices.filter((device) => device.id !== deviceId && device.hardwareId !== deviceId));
  }

  async requestDataDelete(confirmation: string): Promise<void> {
    await firstValueFrom(this.api.post('/data/delete-request', { confirmation }));
  }

  private normalizeAlias(value: string | null | undefined): string {
    return String(value || '').trim().replace(/^@/, '').toLowerCase();
  }

  private currentScope(): string {
    const session = this.auth.session();
    return session?.user.id ? `${session.user.id}:${session.device?.id ?? ''}` : '';
  }

  private observeScope(scope: string): void {
    if (scope === this.observedScope) return;
    this.observedScope = scope;
    this.scopeRevision += 1;
    this.devices.set([]);
    this.privacy.set(null);
    this.entitlements.set(null);
    this.loading.set(false);
  }

  private isCurrent(scope: string, revision: number): boolean {
    return !!scope && scope === this.currentScope() && revision === this.scopeRevision;
  }

  private requireCurrent(scope: string, revision: number): void {
    if (!this.isCurrent(scope, revision)) throw new Error('ACCOUNT_SESSION_CHANGED');
  }
}
