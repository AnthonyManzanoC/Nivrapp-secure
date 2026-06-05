import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { lockClosedOutline } from 'ionicons/icons';
import { AuthService } from '../../core/services/auth.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

const PENDING_VAULT_INVITE_KEY = 'nivra.pendingVaultInvite';

@Component({
  selector: 'app-vault-invite',
  standalone: true,
  imports: [CommonModule, TranslatePipe, IonButton, IonContent, IonIcon, IonSpinner],
  templateUrl: './vault-invite.page.html',
  styleUrls: ['./vault-invite.page.scss'],
})
export class VaultInvitePage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  error = '';

  constructor() {
    addIcons({ lockClosedOutline });
  }

  async ngOnInit(): Promise<void> {
    const code = this.route.snapshot.queryParamMap.get('code')?.trim() ?? '';
    if (!code) {
      this.error = this.translate.instant('VAULT_INVITE.INVALID', 'Invitacion invalida.');
      return;
    }

    localStorage.setItem(PENDING_VAULT_INVITE_KEY, code);
    await this.router.navigateByUrl(this.auth.isAuthenticated()
      ? `/app/vault?invite=${encodeURIComponent(code)}`
      : '/auth');
  }

  async goHome(): Promise<void> {
    await this.router.navigateByUrl(this.auth.isAuthenticated() ? '/app/vault' : '/auth');
  }
}
