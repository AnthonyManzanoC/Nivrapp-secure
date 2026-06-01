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
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly api = inject(NivraApiService);
  private readonly auth = inject(AuthService);
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
    const user = await firstValueFrom(this.api.patch<NivraUser>('/me', patch));
    this.auth.updateUser(user);
    return user;
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
    await firstValueFrom(this.api.delete(`/devices/${encodeURIComponent(deviceId)}`));
    this.devices.update((devices) => devices.filter((device) => device.id !== deviceId));
  }

  async requestDataDelete(confirmation: string): Promise<void> {
    await firstValueFrom(this.api.post('/data/delete-request', { confirmation }));
  }
}
