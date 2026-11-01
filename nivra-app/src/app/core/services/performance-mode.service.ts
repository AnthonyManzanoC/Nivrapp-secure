import { DestroyRef, Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { fromEvent } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NativeDeviceService } from './native-device.service';

type EfficiencyReason = 'thermal' | 'power-save' | 'low-memory' | 'background' | 'offline';

@Injectable({ providedIn: 'root' })
export class PerformanceModeService {
  private readonly nativeDevice = inject(NativeDeviceService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly zone = inject(NgZone);
  private readonly reasons = signal<Set<EfficiencyReason>>(new Set());
  private readonly thermalStatus = signal(0);
  private timer: number | null = null;
  private sampling = false;
  private destroyed = false;

  readonly efficiencyMode = computed(() => {
    const active = this.reasons();
    return active.has('thermal') || active.has('power-save') || active.has('low-memory') || active.has('background');
  });
  readonly offline = computed(() => this.reasons().has('offline'));
  readonly thermalHot = computed(() => this.thermalStatus() >= 2);

  constructor() {
    this.updateReason('offline', typeof navigator !== 'undefined' && !navigator.onLine);
    this.updateReason('background', typeof document !== 'undefined' && document.visibilityState !== 'visible');
    this.applyClasses();

    fromEvent(window, 'online')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateReason('offline', false);
        this.applyClasses();
      });

    fromEvent(window, 'offline')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateReason('offline', true);
        this.applyClasses();
      });

    fromEvent(document, 'visibilitychange')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.updateReason('background', document.visibilityState !== 'visible');
        this.applyClasses();
        this.syncSampling();
      });

    this.syncSampling();
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      if (this.timer !== null) window.clearInterval(this.timer);
    });
  }

  private syncSampling(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (document.visibilityState === 'hidden' || this.destroyed) return;
    this.zone.runOutsideAngular(() => {
      void this.sampleNativeState();
      this.timer = window.setInterval(() => void this.sampleNativeState(), 45_000);
    });
  }

  private async sampleNativeState(): Promise<void> {
    if (this.sampling || this.destroyed || this.inBackground()) return;
    this.sampling = true;
    let diagnostics: Record<string, unknown>;
    try {
      diagnostics = await this.nativeDevice.diagnostics();
    } catch {
      // A failed probe is not evidence that a hot device has cooled down.
      return;
    } finally {
      this.sampling = false;
    }
    if (this.destroyed || this.inBackground()) return;
    const native = (diagnostics as { nativeDiagnostics?: {
      lowMemory?: boolean;
      powerSaveMode?: boolean;
      thermalStatus?: number;
    } | null }).nativeDiagnostics;
    const thermal = Number(native?.thermalStatus ?? 0);
    this.thermalStatus.set(Number.isFinite(thermal) ? thermal : 0);
    this.updateReason('low-memory', Boolean(native?.lowMemory));
    this.updateReason('power-save', Boolean(native?.powerSaveMode));
    this.updateReason('thermal', this.thermalStatus() >= 2);
    this.applyClasses();
  }

  private updateReason(reason: EfficiencyReason, active: boolean): void {
    this.reasons.update((current) => {
      if (current.has(reason) === active) return current;
      const next = new Set(current);
      if (active) {
        next.add(reason);
      } else {
        next.delete(reason);
      }
      return next;
    });
  }

  private inBackground(): boolean { return document.visibilityState === 'hidden'; }

  private applyClasses(): void {
    const root = document.documentElement;
    root.classList.toggle('nivra-efficiency-mode', this.efficiencyMode());
    root.classList.toggle('nivra-offline', this.offline());
    root.classList.toggle('nivra-thermal-hot', this.thermalHot());
  }
}
