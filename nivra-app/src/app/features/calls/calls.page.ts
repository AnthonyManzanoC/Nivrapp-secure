import { CommonModule, DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonContent, IonIcon, IonModal, IonSearchbar } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowDownLeftBoxOutline,
  arrowUpRightBoxOutline,
  callOutline,
  closeCircleOutline,
  closeOutline,
  enterOutline,
  micOffOutline,
  micOutline,
  peopleOutline,
  personAddOutline,
  phonePortraitOutline,
  searchOutline,
  videocamOffOutline,
  videocamOutline,
  volumeHighOutline,
  volumeMuteOutline,
} from 'ionicons/icons';
import { CallSession, Contact, Conversation, Participant, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { CallsService } from '../../core/services/calls.service';
import { ChatService } from '../../core/services/chat.service';
import { MediaStreamDirective } from '../../shared/media-stream.directive';

@Component({
  selector: 'app-calls',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, IonButton, IonContent, IonIcon, IonModal, IonSearchbar, MediaStreamDirective],
  templateUrl: './calls.page.html',
  styleUrls: ['./calls.page.scss'],
})
export class CallsPage {
  readonly calls = inject(CallsService);
  readonly chat = inject(ChatService);
  private readonly auth = inject(AuthService);
  inviteModalOpen = false;
  callQuery = '';
  callBusyId = '';

  constructor() {
    addIcons({
      arrowDownLeftBoxOutline,
      arrowUpRightBoxOutline,
      callOutline,
      closeCircleOutline,
      closeOutline,
      enterOutline,
      micOffOutline,
      micOutline,
      peopleOutline,
      personAddOutline,
      phonePortraitOutline,
      searchOutline,
      videocamOffOutline,
      videocamOutline,
      volumeHighOutline,
      volumeMuteOutline,
    });
  }

  ionViewWillEnter(): void {
    this.calls.clearInactiveCallUi();
    if (!this.calls.activeCall()) {
      this.resetIdleUi(false);
    }
  }

  ionViewWillLeave(): void {
    this.calls.clearInactiveCallUi();
    if (!this.calls.activeCall()) {
      this.resetIdleUi(true);
    }
  }

  async startSelected(type: 'Voice' | 'Video'): Promise<void> {
    const conversation = this.chat.selectedConversation();
    if (!conversation) {
      return;
    }
    const currentUserId = this.auth.session()?.user.id;
    const participantUserIds = conversation.participants
      .filter((participant) => !participant.removedAt && participant.userId !== currentUserId)
      .map((participant) => participant.userId);
    await this.calls.start(type, conversation.id, participantUserIds);
  }

  async startContactCall(contact: Contact, type: 'Voice' | 'Video'): Promise<void> {
    if (this.callBusyId || this.calls.activeCall()) {
      return;
    }
    this.callBusyId = `${type}:${contact.userId}`;
    try {
      const conversation = await this.chat.createDirectConversation(this.contactAsPerson(contact));
      await this.calls.start(type, conversation.id, [contact.userId]);
    } finally {
      this.callBusyId = '';
    }
  }

  async accept(): Promise<void> {
    await this.calls.accept();
  }

  async decline(): Promise<void> {
    await this.calls.decline();
  }

  async endActive(): Promise<void> {
    await this.calls.end();
  }

  async rejoin(callId: string): Promise<void> {
    await this.calls.rejoin(callId);
  }

  canRejoin(callId: string): boolean {
    return !this.calls.activeCall() && Boolean(callId);
  }

  openInviteModal(): void {
    this.inviteModalOpen = true;
  }

  closeInviteModal(): void {
    this.inviteModalOpen = false;
  }

  inviteToCall(contact: Contact): void {
    this.calls.inviteToCall(contact.userId);
    this.inviteModalOpen = false;
  }

  contactLabel(contact: Contact): string {
    return contact.displayName || contact.phone || contact.alias || 'Contacto';
  }

  contactSubLabel(contact: Contact): string {
    return contact.phone || (contact.alias ? `@${contact.alias}` : 'Contacto cifrado');
  }

  contactInitials(contact: Contact): string {
    return this.initials(this.contactLabel(contact));
  }

  contactPhoto(contact: Contact): string {
    return contact.profilePhotoDataUrl || '';
  }

  filteredCallContacts(): Contact[] {
    const query = this.normalize(this.callQuery);
    return this.agendaContacts()
      .filter((contact) => !query || this.matchesContact(contact, query))
      .slice(0, 80);
  }

  uiPhase(): string {
    return this.calls.activeCall() ? this.calls.phase() : 'idle';
  }

  selectedTitle(): string {
    const conversation = this.chat.selectedConversation();
    return conversation ? this.chat.conversationTitle(conversation) : 'Selecciona un chat';
  }

  historyTitle(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationTitle(conversation);
    }
    const primaryUserId = this.primaryHistoryUserId(call);
    if (primaryUserId) {
      return this.chat.participantDisplayName(primaryUserId);
    }
    return call.type === 'Video' ? 'Videollamada' : 'Llamada';
  }

  historyPhoto(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationPhoto(conversation);
    }
    return this.chat.participantPhoto(this.primaryHistoryUserId(call));
  }

  historyInitials(call: CallSession): string {
    return this.initials(this.historyTitle(call));
  }

  historySubtitle(call: CallSession): string {
    const kind = call.type === 'Video' ? 'Videollamada' : 'Llamada';
    const direction = this.historyDirectionLabel(call).toLowerCase();
    const status = this.historyStatusLabel(call.status).toLowerCase();
    return `${kind} ${direction} ${status}`;
  }

  historyStatusLabel(status: string | null | undefined): string {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'missed') {
      return 'perdida';
    }
    if (normalized === 'failed') {
      return 'fallida';
    }
    if (normalized === 'rejected') {
      return 'rechazada';
    }
    if (normalized === 'ringing') {
      return 'sonando';
    }
    if (normalized === 'active') {
      return 'activa';
    }
    return 'finalizada';
  }

  historyDirectionLabel(call: CallSession): string {
    if (String(call.status || '').toLowerCase() === 'missed') {
      return 'perdida';
    }
    return call.initiatorUserId === this.auth.session()?.user.id ? 'saliente' : 'entrante';
  }

  historyIcon(call: CallSession): string {
    const status = String(call.status || '').toLowerCase();
    if (status === 'missed' || status === 'failed' || status === 'rejected') {
      return 'close-circle-outline';
    }
    return call.initiatorUserId === this.auth.session()?.user.id ? 'arrow-up-right-box-outline' : 'arrow-down-left-box-outline';
  }

  historyClass(call: CallSession): string {
    const status = String(call.status || '').toLowerCase();
    if (status === 'missed' || status === 'failed' || status === 'rejected') {
      return 'missed';
    }
    return call.initiatorUserId === this.auth.session()?.user.id ? 'outgoing' : 'incoming';
  }

  isCallingContact(contact: Contact, type: 'Voice' | 'Video'): boolean {
    return this.callBusyId === `${type}:${contact.userId}`;
  }

  private resetIdleUi(clearSearch: boolean): void {
    this.callBusyId = '';
    this.inviteModalOpen = false;
    if (clearSearch) {
      this.callQuery = '';
    }
  }

  private agendaContacts(): Contact[] {
    const currentUserId = this.auth.session()?.user.id;
    const contacts = new Map<string, Contact>();
    for (const contact of this.chat.contacts()) {
      if (contact.userId && contact.userId !== currentUserId) {
        contacts.set(contact.userId, contact);
      }
    }
    for (const conversation of this.chat.conversations()) {
      if (String(conversation.type || '').toLowerCase() !== 'direct') {
        continue;
      }
      const participant = conversation.participants.find((item) => item.userId !== currentUserId && !item.removedAt);
      if (participant?.userId && !contacts.has(participant.userId)) {
        contacts.set(participant.userId, this.participantAsContact(participant));
      }
    }
    return [...contacts.values()].sort((left, right) => {
      const favorite = Number(Boolean(right.isFavorite)) - Number(Boolean(left.isFavorite));
      if (favorite) {
        return favorite;
      }
      return this.contactLabel(left).localeCompare(this.contactLabel(right));
    });
  }

  private matchesContact(contact: Contact, query: string): boolean {
    return [
      contact.displayName,
      contact.phone,
      contact.alias,
    ].some((value) => this.normalize(value).includes(query));
  }

  private contactAsPerson(contact: Contact): UserSummary {
    return {
      id: contact.userId,
      alias: contact.alias,
      displayName: contact.displayName,
      phone: contact.phone,
      bio: contact.bio,
      profilePhotoDataUrl: contact.profilePhotoDataUrl,
      isDiscoverable: true,
      isContact: true,
      isMutualContact: true,
      isFavorite: contact.isFavorite,
      friendshipState: 'contact',
    };
  }

  private participantAsContact(participant: Participant): Contact {
    return {
      userId: participant.userId,
      alias: participant.alias || '',
      displayName: participant.displayName,
      phone: participant.phone,
      bio: null,
      profilePhotoDataUrl: participant.profilePhotoDataUrl,
      nicknameCiphertext: null,
      isFavorite: false,
      createdAt: participant.joinedAt || new Date().toISOString(),
    };
  }

  private conversationForCall(call: CallSession): Conversation | null {
    const conversationId = call.conversationId || call.groupId;
    return conversationId ? this.chat.conversations().find((conversation) => conversation.id === conversationId) ?? null : null;
  }

  private primaryHistoryUserId(call: CallSession): string | null {
    const currentUserId = this.auth.session()?.user.id;
    const ids = [call.initiatorUserId, ...(call.participantUserIds ?? [])]
      .filter((userId): userId is string => Boolean(userId && userId !== currentUserId));
    return [...new Set(ids)][0] ?? null;
  }

  private initials(value: string | null | undefined): string {
    return (value || 'Nivra')
      .split(/\s|,|-/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || 'N';
  }

  private normalize(value: string | null | undefined): string {
    return (value || '').trim().toLowerCase();
  }
}
