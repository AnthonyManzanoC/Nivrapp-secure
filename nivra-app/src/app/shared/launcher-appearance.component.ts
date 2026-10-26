import { Component, DestroyRef, effect, inject, signal } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { checkmarkOutline, personCircleOutline } from 'ionicons/icons';
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
    { id: 'original', key: 'LAUNCHER_ACCOUNT.ORIGINAL', fallback: 'Original' },
    { id: 'emerald', key: 'LAUNCHER_ACCOUNT.EMERALD', fallback: 'Esmeralda' },
    { id: 'ivory', key: 'LAUNCHER_ACCOUNT.IVORY', fallback: 'Marfil' },
  ];
  private destroyed = false;
  private accountSequence = 0;

  constructor() {
    addIcons({ checkmarkOutline, personCircleOutline });
    inject(DestroyRef).onDestroy(() => { this.destroyed = true; });
    effect(() => {
      this.launcher.accountId();
      this.accountSequence++;
      this.saved.set(false);
      this.localError.set(false);
    });
    if (this.launcher.platform() !== 'unsupported') void this.launcher.refresh();
  }

  async selectIcon(icon: LauncherIconId): Promise<void> {
    const accountId = this.launcher.accountId();
    if (!accountId || !this.launcher.supported() || this.launcher.busy() || this.pendingIcon()
      || this.launcher.current() === icon && this.launcher.synced()) return;
    const sequence = this.accountSequence;
    this.saved.set(false);
    this.localError.set(false);
    this.pendingIcon.set(icon);
    try {
      const confirmed = await this.launcher.selectIcon(icon);
      if (!this.destroyed && sequence === this.accountSequence && accountId === this.launcher.accountId()) {
        const applied = confirmed && this.launcher.synced() && this.launcher.revision() !== null
          && this.launcher.current() === icon;
        this.saved.set(applied);
        this.localError.set(!applied);
      }
    } catch {
      if (!this.destroyed && sequence === this.accountSequence && accountId === this.launcher.accountId()) this.localError.set(true);
    } finally {
      this.pendingIcon.set(null);
    }
  }

  async refresh(): Promise<void> {
    if (this.launcher.busy() || this.pendingIcon()) return;
    const accountId = this.launcher.accountId();
    const sequence = this.accountSequence;
    this.localError.set(false);
    this.saved.set(false);
    try {
      await this.launcher.refresh();
    } catch {
      if (!this.destroyed && sequence === this.accountSequence && accountId === this.launcher.accountId()) this.localError.set(true);
    }
  }
}
