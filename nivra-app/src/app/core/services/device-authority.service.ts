import { DestroyRef, Injectable, OnDestroy, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Capacitor } from '@capacitor/core';
import { firstValueFrom, fromEvent, timeout } from 'rxjs';
import { AccountIdentityService } from './account-identity.service';
import { AuthService } from './auth.service';
import { AppLockService } from './app-lock.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { identityBytes, signAccountIdentity } from '../utils/account-identity';
import type {} from './desktop-update.service';

export interface DeviceAuthorityNode { deviceId: string; platform: string; role: 'primary' | 'mirror'; verifiedAt: string | null; }
export interface DeviceAuthority { primaryDeviceId: string | null; devices: DeviceAuthorityNode[]; }

/** A preference for synchronization sources, never authorization to read or encrypt messages. */
@Injectable({ providedIn: 'root' })
export class DeviceAuthorityService implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly identity = inject(AccountIdentityService);
  private readonly lock = inject(AppLockService);
  private readonly api = inject(NivraApiService);
  private readonly realtime = inject(SignalrService);
  private readonly destroyRef = inject(DestroyRef);
  readonly authority = signal<DeviceAuthority | null>(null);
  private epoch = 0;
  private scope = '';
  private advertised = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private rerun = false;
  private stopped = false;

  constructor() {
    effect(() => {
      const session = this.auth.session();
      const scope = session && !this.lock.isContentLocked() && this.identity.state() === 'ready'
        ? JSON.stringify([session.user.id, session.device.id, this.auth.sessionGeneration()]) : '';
      if (scope !== this.scope) untracked(() => {
        this.epoch++; this.scope = scope; this.advertised = ''; this.authority.set(null);
        if (this.timer) clearTimeout(this.timer); this.timer = null;
        if (scope) void this.refresh();
      });
    });
    this.realtime.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(event => {
      if (['connected', 'reconnected', 'device.listChanged'].includes(event.type)) void this.refresh();
    });
    fromEvent(window, 'online').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => void this.refresh());
    fromEvent(document, 'visibilitychange').pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (document.visibilityState === 'visible') void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (!this.scope || this.stopped) return;
    if (this.running) { this.rerun = true; return; }
    this.running = true;
    const epoch = this.epoch, session = this.auth.session();
    const current = () => epoch === this.epoch && !!this.scope && !this.stopped && !this.lock.isContentLocked();
    try {
      if (!session) return;
      const identity = await this.identity.exportForDevice(); if (!current() || !identity) return;
      const platform = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? 'android'
        : window.nivraDesktopUpdates ? 'desktop' : 'web';
      const mark = JSON.stringify([this.scope, identity.secret.rootKey, platform]);
      if (this.advertised !== mark) {
        const statement = identityBytes(['nivra-device-platform-v1', session.user.id, identity.secret.rootKey, session.device.id, platform]);
        const signature = await signAccountIdentity(identity.secret, statement); if (!current()) return;
        const authority = await firstValueFrom(this.api.post<DeviceAuthority>('/devices/authority/platform', {
          v: 1, rootKey: identity.secret.rootKey, deviceId: session.device.id, platform, signature,
        }).pipe(timeout(15000)));
        if (current()) { this.authority.set(authority); this.advertised = mark; }
      } else {
        const authority = await firstValueFrom(this.api.get<DeviceAuthority>('/devices/authority').pipe(timeout(15000)));
        if (current()) this.authority.set(authority);
      }
    } catch {
      // Older APIs and offline sessions keep working; routing preference is optional.
    } finally {
      this.running = false;
      if (this.timer) clearTimeout(this.timer);
      if (this.rerun) { this.rerun = false; if (this.scope && !this.stopped) void this.refresh(); }
      else if (this.scope && !this.stopped) this.timer = setTimeout(() => {
        this.timer = null;
        if (document.visibilityState === 'visible') void this.refresh();
      }, 60000);
    }
  }

  ngOnDestroy(): void { this.stopped = true; this.epoch++; this.scope = ''; if (this.timer) clearTimeout(this.timer); }
}
