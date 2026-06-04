import { DestroyRef, Injectable, inject, signal } from '@angular/core';
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

  constructor() {
    this.realtime.events$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => {
        if (event.type === 'device.listChanged' && this.auth.isAuthenticated()) {
          void this.load();
        }
      });
  }

  async load(): Promise<void> {
    if (!this.auth.isAuthenticated()) {
      return;
    }
    this.loading.set(true);
    try {
      const [me, devices, privacy, entitlements] = await Promise.all([
        firstValueFrom(this.api.get<NivraUser>('/me')),
        firstValueFrom(this.api.get<NivraDevice[]>('/devices')),
        firstValueFrom(this.api.get<PrivacySettings>('/privacy')),
        firstValueFrom(this.api.get<Entitlements>('/monetization/entitlements')).catch(() => null),
      ]);
      this.auth.updateUser(me);
      this.devices.set(devices ?? []);
      this.privacy.set(privacy);
      this.entitlements.set(entitlements);
    } finally {
      this.loading.set(false);
    }
  }

  async updateProfile(patch: PatchProfileRequest): Promise<NivraUser> {
    const current = this.auth.session();
    const requestedAlias = this.normalizeAlias(patch.alias);
    const shouldMoveLocalKeys = Boolean(
      current?.device?.id &&
      requestedAlias &&
      requestedAlias !== this.normalizeAlias(current.user.alias),
    );
    const currentKeys = shouldMoveLocalKeys && current
      ? await this.crypto.currentKeyMaterial(current.user.alias, current.device.id)
      : null;

    const user = await firstValueFrom(this.api.patch<NivraUser>('/me', patch));
    if (currentKeys && current?.device?.id) {
      await this.crypto.saveDeviceKeys(
        user.alias,
        current.device.id,
        this.crypto.materialToDeviceKeys(currentKeys),
        { userId: user.id },
      );
    }
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
    const privacy = await firstValueFrom(this.api.patch<PrivacySettings>('/privacy', patch));
    this.privacy.set(privacy);
    const current = this.auth.session();
    if (current) {
      this.auth.updateUser({ ...current.user, privacySettings: privacy });
    }
    return privacy;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await firstValueFrom(this.api.post(`/devices/${encodeURIComponent(deviceId)}/revoke`, {}));
    this.devices.update((devices) => devices.filter((device) => device.id !== deviceId && device.hardwareId !== deviceId));
  }

  async requestDataDelete(confirmation: string): Promise<void> {
    await firstValueFrom(this.api.post('/data/delete-request', { confirmation }));
  }

  private normalizeAlias(value: string | null | undefined): string {
    return String(value || '').trim().replace(/^@/, '').toLowerCase();
  }
}
