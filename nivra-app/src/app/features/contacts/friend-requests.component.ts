import { TransientNoticeDirective } from '../../shared/transient-notice.directive';
import { Component, OnDestroy, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { FriendRequest, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { identityDisplayName } from '../../core/utils/nivra-identity';
import { friendRequestStatus } from '../../core/services/social-connections.helpers';

@Component({
  selector:'app-friend-requests', standalone:true,
  imports:[TransientNoticeDirective, FormsModule, TranslatePipe, LocalizedDatePipe, IonButton, IonIcon, IonSpinner],
  templateUrl:'./friend-requests.component.html', styleUrls:['./friend-requests.component.scss'],
})
export class FriendRequestsComponent implements OnDestroy {
  readonly social = inject(SocialService);
  readonly auth = inject(AuthService);
  private readonly translate = inject(TranslateService);
  readonly personName = identityDisplayName;
  query = '';
  error = '';
  private revision = 0;
  private destroyed = false;
  private scope = this.accountScope();
  private readonly running = new Set<string>();

  constructor() {
    effect(() => {
      const scope = this.accountScope();
      untracked(() => {
        if (scope === this.scope) return;
        this.scope = scope; ++this.revision;
        this.running.clear(); this.error = ''; this.query = '';
      });
    });
  }
  ngOnDestroy(): void { this.destroyed = true; ++this.revision; }
  private accountScope(): string {
    const session = this.auth.session();
    return session ? `${session.user.id}:${session.device.id}` : '';
  }
  private async run(id: string, action: () => Promise<void>): Promise<void> {
    if (this.running.has(id) || this.destroyed) return;
    const scope = this.accountScope(), revision = this.revision;
    const current = () => !this.destroyed && scope === this.accountScope() && revision === this.revision;
    this.running.add(id); this.error = '';
    try { await action(); }
    catch { if (current()) this.error = 'No se pudo completar la solicitud. Vuelve a intentarlo.'; }
    finally { if (current()) this.running.delete(id); }
  }
  accept(id: string) { return this.run(id, () => this.social.accept(id)); }
  reject(id: string) { return this.run(id, () => this.social.reject(id)); }
  cancel(id: string) { return this.run(id, () => this.social.cancel(id)); }
  requestPerson(request: FriendRequest): UserSummary {
    return request.from.id === this.auth.session()?.user.id ? request.to : request.from;
  }
  requestBusy(request: FriendRequest): boolean {
    return this.running.has(request.id) || this.social.connectionActions().includes(`person:${this.requestPerson(request).id}`);
  }
  requestStatus(request: FriendRequest): string {
    const state = friendRequestStatus(request);
    return this.translate.instant(`WORLD.REQUEST_${state.toUpperCase()}`,
      state === 'accepted' ? 'Aceptada' : state === 'rejected' ? 'Rechazada' : state === 'cancelled' ? 'Cancelada' : 'Cerrada');
  }
  filteredRequests(requests: FriendRequest[]): FriendRequest[] {
    const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase();
    const query = normalize(this.query.trim());
    return requests.filter(request => !query || normalize(`${this.personName(this.requestPerson(request))} ${this.requestPerson(request).alias}`).includes(query));
  }
}
