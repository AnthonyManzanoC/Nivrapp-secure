import { CommonModule } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { backspaceOutline, fingerPrintOutline, lockClosedOutline, scanOutline } from 'ionicons/icons';
import { AppLockService } from '../core/services/app-lock.service';
import { TranslatePipe } from '../core/pipes/translate.pipe';

@Component({
  selector: 'app-lock-screen',
  standalone: true,
  imports: [CommonModule, TranslatePipe, IonIcon, IonSpinner],
  templateUrl: './app-lock-screen.component.html',
  styleUrls: ['./app-lock-screen.component.scss'],
})
export class AppLockScreenComponent {
  readonly appLock = inject(AppLockService);
  readonly pin = signal('');
  readonly pinDots = computed(() => Array.from({ length: 4 }, (_, index) => index < this.pin().length));
  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'backspace'];

  constructor() {
    addIcons({ backspaceOutline, fingerPrintOutline, lockClosedOutline, scanOutline });
  }

  async unlockMobile(): Promise<void> {
    await this.appLock.unlockWithBiometrics();
  }

  pressKey(key: string): void {
    if (!key || this.appLock.busy()) {
      return;
    }
    if (key === 'backspace') {
      this.pin.update((value) => value.slice(0, -1));
      return;
    }
    const next = this.appLock.normalizePin(`${this.pin()}${key}`);
    this.pin.set(next);
    if (next.length === 4) {
      void this.submitPin(next);
    }
  }

  private async submitPin(pin: string): Promise<void> {
    const ok = await this.appLock.unlockWithPin(pin);
    if (!ok) {
      window.setTimeout(() => this.pin.set(''), 140);
    }
  }
}
