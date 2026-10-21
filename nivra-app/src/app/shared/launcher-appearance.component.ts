import { Component, DestroyRef, inject, signal } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkOutline, desktopOutline, phonePortraitOutline } from 'ionicons/icons';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { LAUNCHER_ICON_IDS, LauncherAppearanceService } from '../core/services/launcher-appearance.service';

type LauncherIconId = (typeof LAUNCHER_ICON_IDS)[number];

@Component({
  selector: 'app-launcher-appearance',
  standalone: true,
  imports: [TranslatePipe, IonIcon, IonSpinner],
  templateUrl: './launcher-appearance.component.html',
  styleUrls: ['./launcher-appearance.component.scss'],
})
export class LauncherAppearanceComponent {
  readonly launcher = inject(LauncherAppearanceService);
  readonly pendingIcon = signal<LauncherIconId | null>(null);
  readonly saved = signal(false);
  readonly localError = signal(false);
  readonly options: ReadonlyArray<{ id: LauncherIconId; key: string; fallback: string }> = [
    { id: 'original', key: 'LAUNCHER.ORIGINAL', fallback: 'Original' },
    { id: 'emerald', key: 'LAUNCHER.EMERALD', fallback: 'Esmeralda' },
    { id: 'ivory', key: 'LAUNCHER.IVORY', fallback: 'Marfil' },
  ];
  private destroyed = false;

  constructor() {
    addIcons({ checkmarkOutline, desktopOutline, phonePortraitOutline });
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; });
    if (this.launcher.platform() !== 'unsupported') void this.launcher.refresh();
  }

  async selectIcon(icon: LauncherIconId): Promise<void> {
    if (!this.launcher.supported() || this.launcher.busy() || this.pendingIcon() || this.launcher.current() === icon) return;
    this.saved.set(false);
    this.localError.set(false);
    this.pendingIcon.set(icon);
    try {
      const confirmed = await this.launcher.selectIcon(icon);
      if (!this.destroyed) {
        const applied = confirmed && this.launcher.current() === icon;
        this.saved.set(applied);
        this.localError.set(!applied);
      }
    } catch {
      if (!this.destroyed) this.localError.set(true);
    } finally {
      this.pendingIcon.set(null);
    }
  }

  async refresh(): Promise<void> {
    this.localError.set(false);
    this.saved.set(false);
    await this.launcher.refresh();
  }
}
