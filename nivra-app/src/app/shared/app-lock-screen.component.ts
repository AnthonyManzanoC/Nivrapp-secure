import { CommonModule } from '@angular/common';
import { Component, DestroyRef, ElementRef, HostListener, computed, effect, inject, signal, viewChild } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowForwardOutline, backspaceOutline, fingerPrintOutline, lockClosedOutline, scanOutline, shieldCheckmarkOutline } from 'ionicons/icons';
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
  readonly inputDisabled = computed(() => this.appLock.busy() || this.appLock.pinRetrySeconds() > 0);
  readonly verificationIcon = computed(() => {
    const label = this.appLock.biometryLabel().toLocaleLowerCase();
    if (label.includes('rostro') || label.includes('facial')) return 'scan-outline';
    if (label.includes('huella')) return 'finger-print-outline';
    return 'shield-checkmark-outline';
  });
  readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'backspace'];
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('lockDialog');
  private previousFocus: HTMLElement | null = null;
  private submitting = false;

  constructor() {
    addIcons({ arrowForwardOutline, backspaceOutline, fingerPrintOutline, lockClosedOutline, scanOutline, shieldCheckmarkOutline });
    effect(() => {
      const locked = this.appLock.isContentLocked();
      this.appLock.lockCycle();
      this.appLock.unlockMode();
      this.pin.set('');
      const dialog = this.dialog()?.nativeElement;
      if (locked && dialog) {
        if (!this.previousFocus && document.activeElement instanceof HTMLElement
          && !dialog.contains(document.activeElement)) this.previousFocus = document.activeElement;
        dialog.focus({ preventScroll: true });
      } else if (!locked && this.previousFocus) {
        const previous = this.previousFocus;
        this.previousFocus = null;
        queueMicrotask(() => {
          if (!this.appLock.isContentLocked() && previous.isConnected && !previous.closest('[inert]')) {
            previous.focus({ preventScroll: true });
          }
        });
      }
    });
    inject(DestroyRef).onDestroy(() => this.pin.set(''));
  }

  async unlockMobile(): Promise<void> {
    if (!this.appLock.isLocked() || this.appLock.unlockMode() !== 'biometric' || this.appLock.busy() || this.submitting) return;
    await this.appLock.unlockWithBiometrics();
  }

  usePin(): void {
    if (!this.appLock.isLocked() || this.appLock.busy() || this.submitting || !this.appLock.hasPinFallback()) return;
    this.pin.set('');
    this.appLock.usePin();
  }

  useBiometrics(): void {
    if (!this.appLock.isLocked() || this.appLock.busy() || this.submitting || !this.appLock.canUseBiometric()) return;
    this.pin.set('');
    this.appLock.useBiometrics();
  }

  pressKey(key: string): void {
    if (!this.appLock.isLocked() || this.appLock.unlockMode() !== 'pin' || this.inputDisabled() || this.submitting) return;
    if (key === 'backspace') {
      this.pin.update(value => value.slice(0, -1));
      return;
    }
    if (!/^\d$/.test(key)) return;
    const next = this.appLock.normalizePin(`${this.pin()}${key}`);
    this.pin.set(next);
    if (next.length === 4) void this.submitPin(next);
  }

  @HostListener('document:keydown', ['$event'])
  handleKeydown(event: KeyboardEvent): void {
    if (!this.appLock.isContentLocked() || event.altKey || event.ctrlKey || event.metaKey) return;
    const dialog = this.dialog()?.nativeElement;
    if (event.key === 'Tab' && dialog) {
      const focusable = Array.from(dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    } else if (this.appLock.unlockMode() === 'pin' && !event.repeat && (/^\d$/.test(event.key) || event.key === 'Backspace')) {
      event.preventDefault();
      event.stopPropagation();
      this.pressKey(event.key === 'Backspace' ? 'backspace' : event.key);
    }
  }

  private async submitPin(pin: string): Promise<void> {
    this.submitting = true;
    try {
      await this.appLock.unlockWithPin(pin);
    } finally {
      // No delayed reset can erase a new attempt; successful entries are cleared too.
      this.pin.set('');
      this.submitting = false;
    }
  }
}
