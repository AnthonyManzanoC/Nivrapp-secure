import { Component, computed, inject, signal } from '@angular/core';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, checkmarkCircle, closeOutline, personOutline } from 'ionicons/icons';
import { TranslatePipe } from '../core/pipes/translate.pipe';
import { AuthService } from '../core/services/auth.service';
import { AccountSessionSummary } from '../core/services/account-sessions.service';
import { CallsService } from '../core/services/calls.service';
import { identityDisplayName, isNivraIdAccount } from '../core/utils/nivra-identity';
import { formatNivraNumber } from '../core/utils/nivra-number';

@Component({
  selector: 'app-account-switcher',
  standalone: true,
  imports: [TranslatePipe, IonIcon, IonSpinner],
  templateUrl: './account-switcher.component.html',
  styleUrls: ['./account-switcher.component.scss'],
})
export class AccountSwitcherComponent {
  readonly auth = inject(AuthService);
  private readonly calls = inject(CallsService);
  readonly callInProgress = computed(() => Boolean(this.calls.activeCall() || this.calls.resumableCall()));
  readonly removing = signal<string | null>(null);
  readonly localError = signal(false);

  constructor() { addIcons({ addOutline, checkmarkCircle, closeOutline, personOutline }); }

  label(account: AccountSessionSummary): string {
    return identityDisplayName(account, 'Nivra');
  }

  subtitle(account: AccountSessionSummary): string {
    return isNivraIdAccount(account) ? formatNivraNumber(account.nivraNumber) || 'Nivra ID' : `@${account.alias}`;
  }

  async switchAccount(account: AccountSessionSummary): Promise<void> {
    if (this.auth.accountsBusy() || this.callInProgress() || account.active) return;
    this.removing.set(null);
    this.localError.set(false);
    try { this.localError.set(!await this.auth.switchAccount(account.id)); }
    catch { this.localError.set(true); }
  }

  async addAccount(): Promise<void> {
    if (this.auth.accountsBusy() || this.callInProgress() || this.auth.savedAccounts().length >= 2) return;
    this.removing.set(null);
    this.localError.set(false);
    try { await this.auth.beginAddAccount(); }
    catch { this.localError.set(true); }
  }

  async removeAccount(account: AccountSessionSummary): Promise<void> {
    if (this.auth.accountsBusy() || account.active && this.callInProgress() || this.removing() !== account.id) return;
    this.localError.set(false);
    try { await this.auth.removeAccount(account.id); this.removing.set(null); }
    catch { this.localError.set(true); }
  }
}
