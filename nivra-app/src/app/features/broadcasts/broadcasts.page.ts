import { Component, OnDestroy, OnInit, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonIcon, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, arrowBackOutline, checkmarkCircleOutline, closeOutline, createOutline, lockClosedOutline, megaphoneOutline, refreshOutline, searchOutline, sendOutline, shieldCheckmarkOutline, trashOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { AuthService } from '../../core/services/auth.service';
import { BroadcastDispatch, BroadcastListVm, BroadcastService, MAX_BROADCAST_RECIPIENTS } from '../../core/services/broadcast.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { identityDisplayName } from '../../core/utils/nivra-identity';

@Component({
  selector: 'app-broadcasts', standalone: true,
  imports: [FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonSpinner, IonTextarea],
  templateUrl: './broadcasts.page.html', styleUrls: ['./broadcasts.page.scss'],
})
export class BroadcastsPage implements OnInit, OnDestroy {
  readonly broadcasts = inject(BroadcastService);
  readonly social = inject(SocialService);
  readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  readonly limit = MAX_BROADCAST_RECIPIENTS;
  readonly personName = identityDisplayName;
  readonly selectedId = signal('');
  readonly selectedList = computed(() => this.broadcasts.lists().find(list => list.id === this.selectedId()) ?? null);
  readonly selectedRecipients = signal<string[]>([]);
  readonly recipientQuery = signal('');
  readonly visibleContacts = computed(() => {
    const query = this.recipientQuery().trim().toLocaleLowerCase();
    const ownerId = this.auth.session()?.user.id;
    return this.social.contacts().filter(contact => contact.userId !== ownerId)
      .filter(contact => !query || `${identityDisplayName(contact)} ${contact.alias} ${contact.nivraNumber ?? ''}`.toLocaleLowerCase().includes(query))
      .sort((a, b) => identityDisplayName(a).localeCompare(identityDisplayName(b)));
  });
  readonly missingRecipients = computed(() => {
    const saved = new Set(this.social.contacts().map(contact => contact.userId));
    return this.selectedRecipients().filter(id => !saved.has(id));
  });
  readonly failedCount = computed(() => this.broadcasts.lastDispatch()?.results.filter(result => result.status === 'failed').length ?? 0);
  readonly pendingCount = computed(() => this.broadcasts.lastDispatch()?.results.filter(result => result.status === 'pending').length ?? 0);
  readonly remainingCount = computed(() => this.failedCount() + this.pendingCount());
  readonly sentCount = computed(() => this.broadcasts.lastDispatch()?.results.filter(result => result.status === 'sent').length ?? 0);
  editorOpen = false;
  editingList: BroadcastListVm | undefined;
  name = '';
  draft = '';
  error = '';
  notice = '';
  private action = '';
  private destroyed = false;
  private epoch = 0;
  private scope = this.accountScope();
  private readonly drafts = new Map<string, string>();

  constructor() {
    addIcons({ addOutline, arrowBackOutline, checkmarkCircleOutline, closeOutline, createOutline, lockClosedOutline, megaphoneOutline, refreshOutline, searchOutline, sendOutline, shieldCheckmarkOutline, trashOutline });
    effect(() => {
      const scope = this.accountScope();
      untracked(() => {
        if (scope === this.scope) return;
        this.scope = scope; ++this.epoch;
        this.selectedId.set(''); this.selectedRecipients.set([]); this.recipientQuery.set(''); this.drafts.clear();
        this.editorOpen = false; this.editingList = undefined; this.name = ''; this.draft = ''; this.error = ''; this.notice = ''; this.action = '';
      });
    });
  }

  async ngOnInit(): Promise<void> { await this.refresh(); }
  ngOnDestroy(): void { this.destroyed = true; ++this.epoch; this.drafts.clear(); this.broadcasts.clearEphemeralDispatch(); }

  async refresh(): Promise<void> {
    await Promise.allSettled([this.broadcasts.load(), this.social.loadConnections()]);
  }

  select(list: BroadcastListVm): void {
    this.rememberDraft();
    this.selectedId.set(list.id);
    this.draft = this.drafts.get(list.id) ?? '';
    this.error = ''; this.notice = ''; this.editorOpen = false;
  }

  openEditor(list?: BroadcastListVm): void {
    if (list?.locked || this.broadcasts.saving()) return;
    if (list && this.broadcasts.lastDispatch()?.listId === list.id && this.remainingCount()
      && !window.confirm(this.tr('BROADCAST.EDIT_PENDING_CONFIRM', 'Esta lista tiene destinos pendientes. Si guardas cambios, se reemplazará ese seguimiento. Los mensajes enviados se conservan. ¿Continuar?'))) return;
    this.editingList = list;
    this.name = list?.name ?? '';
    this.selectedRecipients.set([...(list?.recipientUserIds ?? [])]);
    this.recipientQuery.set(''); this.error = ''; this.notice = ''; this.editorOpen = true;
  }

  closeEditor(): void { if (!this.broadcasts.saving()) this.editorOpen = false; }
  staleEditor(): boolean { return !!this.editingList && !this.broadcasts.lists().some(list => list.id === this.editingList!.id && list.revision === this.editingList!.revision); }

  toggleRecipient(userId: string): void {
    if (this.broadcasts.saving() || !this.social.contacts().some(contact => contact.userId === userId) || userId === this.auth.session()?.user.id) return;
    const selected = this.selectedRecipients();
    if (selected.includes(userId)) this.selectedRecipients.set(selected.filter(id => id !== userId));
    else if (selected.length < this.limit) this.selectedRecipients.set([...selected, userId]);
  }

  removeMissingRecipients(): void {
    const missing = new Set(this.missingRecipients());
    this.selectedRecipients.update(ids => ids.filter(id => !missing.has(id)));
  }

  async save(): Promise<void> {
    if (this.action || this.broadcasts.saving() || this.broadcasts.sending() || this.social.contactsLoading()) return;
    if (!this.name.trim() || !this.selectedRecipients().length || this.selectedRecipients().length > this.limit || this.missingRecipients().length || this.staleEditor()) {
      this.error = this.tr('BROADCAST.VALIDATION', 'Escribe un nombre y elige entre 1 y 256 contactos guardados.'); return;
    }
    const current = this.guard();
    this.action = 'save'; this.error = ''; this.notice = '';
    try {
      const list = await this.broadcasts.save(this.name.trim(), [...this.selectedRecipients()], this.editingList);
      if (!current()) return;
      this.select(list); this.editorOpen = false;
      this.notice = this.tr('BROADCAST.SAVED', 'Lista guardada. Aún no se ha enviado ningún mensaje.');
    } catch (error) { if (current()) this.error = this.message(error); }
    finally { if (current()) this.action = ''; }
  }

  async remove(list: BroadcastListVm): Promise<void> {
    if (this.action || this.broadcasts.saving() || this.broadcasts.sending()) return;
    if (!window.confirm(`${this.tr('BROADCAST.DELETE_CONFIRM', '¿Eliminar esta lista? Tus chats y mensajes se conservan.')}\n\n${list.name}`)) return;
    const current = this.guard(); this.action = `remove:${list.id}`; this.error = ''; this.notice = '';
    try {
      await this.broadcasts.remove(list);
      if (!current()) return;
      this.drafts.delete(list.id);
      if (this.selectedId() === list.id) { this.selectedId.set(''); this.draft = ''; }
      this.notice = this.tr('BROADCAST.DELETED', 'Lista eliminada.');
    } catch (error) { if (current()) this.error = this.message(error); }
    finally { if (current()) this.action = ''; }
  }

  sameUnconfirmedMessage(): boolean {
    const dispatch = this.broadcasts.lastDispatch();
    return !!dispatch && dispatch.listId === this.selectedId() && dispatch.text === this.draft.trim() && this.remainingCount() > 0;
  }

  async send(): Promise<void> {
    const list = this.selectedList();
    const text = this.draft.trim();
    if (this.action || this.broadcasts.sending() || this.broadcasts.saving() || !list || list.locked || !text || text.length > 10000 || this.sameUnconfirmedMessage()) return;
    if (this.remainingCount() && !window.confirm(this.tr('BROADCAST.REPLACE_RESULT_CONFIRM', 'Hay destinatarios sin confirmar del envío anterior. Si inicias otro mensaje, perderás su botón de reintento. ¿Continuar con el nuevo envío?'))) return;
    const current = this.guard();
    const draft = this.draft;
    this.action = 'send'; this.error = ''; this.notice = '';
    try {
      const dispatch = await this.broadcasts.sendText(list, text);
      if (!current()) return;
      if (dispatch.results.some(result => result.status === 'sent')) {
        if (this.drafts.get(list.id) === draft) this.drafts.delete(list.id);
        if (this.selectedId() === list.id && this.draft === draft) this.draft = '';
      }
      this.report(dispatch);
    } catch (error) { if (current()) this.error = this.message(error); }
    finally { if (current()) this.action = ''; }
  }

  async retryFailed(): Promise<void> {
    if (this.action || this.broadcasts.sending() || this.broadcasts.saving() || !this.remainingCount()) return;
    const current = this.guard(); this.action = 'retry'; this.error = ''; this.notice = '';
    try {
      const dispatch = await this.broadcasts.retryFailed();
      if (current() && dispatch) {
        if (dispatch.results.some(result => result.status === 'sent')) {
          if (this.drafts.get(dispatch.listId)?.trim() === dispatch.text) this.drafts.delete(dispatch.listId);
          if (this.selectedId() === dispatch.listId && this.draft.trim() === dispatch.text) this.draft = '';
        }
        this.report(dispatch);
      }
    } catch (error) { if (current()) this.error = this.message(error); }
    finally { if (current()) this.action = ''; }
  }

  recipientName(userId: string): string {
    const contact = this.social.contacts().find(item => item.userId === userId);
    return contact ? identityDisplayName(contact) : `${this.tr('BROADCAST.UNAVAILABLE_CONTACT', 'Contacto no disponible')} · ${userId.slice(-6)}`;
  }
  dispatchName(dispatch: BroadcastDispatch): string { return this.broadcasts.lists().find(list => list.id === dispatch.listId)?.name ?? this.tr('BROADCAST.LIST', 'Lista de difusión'); }
  back(): Promise<boolean> { return this.router.navigateByUrl('/app/chats'); }
  openAccount(): Promise<boolean> { return this.router.navigateByUrl('/app/account'); }
  private rememberDraft(): void { if (this.selectedId()) this.drafts.set(this.selectedId(), this.draft); }
  private report(dispatch: BroadcastDispatch): void {
    const sent = dispatch.results.filter(result => result.status === 'sent').length;
    this.notice = `${sent}/${dispatch.results.length} ${this.tr('BROADCAST.SENT_COUNT', 'mensajes enviados')}.`;
  }
  private accountScope(): string { const session = this.auth.session(); return session ? `${session.user.id}:${session.device.id}` : ''; }
  private guard(): () => boolean { const scope = this.accountScope(); const epoch = this.epoch; return () => !this.destroyed && this.accountScope() === scope && this.epoch === epoch; }
  private tr(key: string, fallback: string): string { return this.translate.instant(key, fallback); }
  private message(error: unknown): string { return error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la acción.'); }
}
