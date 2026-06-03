import { CommonModule } from '@angular/common';
import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { IonButton, IonContent, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chatbubbleEllipsesOutline, personAddOutline } from 'ionicons/icons';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';

const PENDING_CONTACT_ALIAS_KEY = 'nivra.pendingContactAlias';
const ALIAS_PATTERN = /^[a-zA-Z0-9_.-]{3,32}$/;

@Component({
  selector: 'app-contact-invite',
  standalone: true,
  imports: [CommonModule, IonButton, IonContent, IonIcon, IonSpinner],
  templateUrl: './contact-invite.page.html',
  styleUrls: ['./contact-invite.page.scss'],
})
export class ContactInvitePage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly chat = inject(ChatService);
  alias = '';
  loading = true;
  error = '';

  constructor() {
    addIcons({ chatbubbleEllipsesOutline, personAddOutline });
  }

  async ngOnInit(): Promise<void> {
    this.alias = this.normalizeAlias(this.route.snapshot.queryParamMap.get('alias') || '');
    if (!this.alias) {
      this.fail('Invitacion de contacto invalida.');
      return;
    }

    if (!this.auth.isAuthenticated()) {
      localStorage.setItem(PENDING_CONTACT_ALIAS_KEY, this.alias);
      await this.router.navigateByUrl('/auth');
      return;
    }

    await this.openContact();
  }

  async retry(): Promise<void> {
    this.loading = true;
    this.error = '';
    await this.openContact();
  }

  async goChats(): Promise<void> {
    await this.router.navigateByUrl('/app/chats');
  }

  private async openContact(): Promise<void> {
    try {
      if (this.auth.session()?.user?.alias?.toLowerCase() === this.alias.toLowerCase()) {
        this.fail('Este QR pertenece a tu propia cuenta.');
        return;
      }

      const people = await this.chat.searchPeople(this.alias);
      const person = people.find((item) => item.alias.toLowerCase() === this.alias.toLowerCase());
      if (!person) {
        this.fail(`No encontre @${this.alias}.`);
        return;
      }

      const conversation = await this.chat.createDirectConversation(person);
      await this.router.navigate(['/app/chats', conversation.id]);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'No se pudo abrir este contacto.');
    }
  }

  private normalizeAlias(value: string): string {
    const alias = value.trim().replace(/^@/, '');
    return ALIAS_PATTERN.test(alias) ? alias.toLowerCase() : '';
  }

  private fail(message: string): void {
    this.loading = false;
    this.error = message;
  }
}
