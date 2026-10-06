import { CommonModule } from '@angular/common';
import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonContent, IonIcon, IonModal, IonSearchbar, IonToast } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  arrowDownLeftBoxOutline,
  arrowUpRightBoxOutline,
  callOutline,
  closeCircleOutline,
  closeOutline,
  desktopOutline,
  enterOutline,
  gameControllerOutline,
  micOffOutline,
  micOutline,
  peopleOutline,
  personAddOutline,
  phonePortraitOutline,
  refreshOutline,
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
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { LocalizedDatePipe } from '../../core/pipes/localized-date.pipe';
import { TranslateService } from '../../core/services/translate.service';
import { MediaStreamDirective } from '../../shared/media-stream.directive';
import { CallGamePanelComponent } from '../../shared/call-game-panel.component';

type CallIdentityProfile = {
  userId?: string | null;
  id?: string | null;
  alias?: string | null;
  displayName?: string | null;
  phone?: string | null;
  profilePhotoDataUrl?: string | null;
};

type RemoteEntry = [string, MediaStream];

interface VideoTile {
  id: string;
  stream: MediaStream;
  local: boolean;
}

@Component({
  selector: 'app-calls',
  standalone: true,
  imports: [LocalizedDatePipe, CommonModule, FormsModule, TranslatePipe, IonButton, IonContent, IonIcon, IonModal, IonSearchbar, IonToast, MediaStreamDirective, CallGamePanelComponent],
  templateUrl: './calls.page.html',
  styleUrls: ['./calls.page.scss'],
})
export class CallsPage {
  readonly calls = inject(CallsService);
  readonly chat = inject(ChatService);
  private readonly translate = inject(TranslateService);
  private readonly auth = inject(AuthService);
  inviteModalOpen = false;
  callQuery = '';
  callBusyId = '';
  videoSwapped = false;
  pinnedParticipantId: string | null = null;
  controlsVisible = true;
  private controlsHideTimer: number | null = null;
  private readonly videoTrackRevision = signal(0);

  constructor() {
    addIcons({
      arrowDownLeftBoxOutline,
      arrowUpRightBoxOutline,
      callOutline,
      closeCircleOutline,
      closeOutline,
      desktopOutline,
      enterOutline,
      gameControllerOutline,
      micOffOutline,
      micOutline,
      peopleOutline,
      personAddOutline,
      phonePortraitOutline,
      refreshOutline,
      searchOutline,
      videocamOffOutline,
      videocamOutline,
      volumeHighOutline,
      volumeMuteOutline,
    });

    effect(() => {
      const screenShareId = this.calls.activeScreenShareStreamId();
      untracked(() => {
        if (screenShareId && this.calls.activeCall()?.type === 'Video') {
          this.pinnedParticipantId = screenShareId;
          this.revealCallChrome();
          return;
        }
        if (!screenShareId && this.isScreenShareTileId(this.pinnedParticipantId)) {
          this.pinnedParticipantId = null;
          this.revealCallChrome();
        }
      });
    });

    // Track readiness changes on the same MediaStream object. Refresh the tile when
    // the browser starts (or stops) receiving frames, without polling the camera.
    effect((onCleanup) => {
      const streams = [this.calls.localStream(), ...this.calls.remoteEntries().map((entry) => entry[1])]
        .filter((stream): stream is MediaStream => Boolean(stream));
      const listeners: Array<() => void> = [];
      const observed = new Set<MediaStreamTrack>();
      const refresh = () => this.videoTrackRevision.update((revision) => revision + 1);
      const observeTracks = (stream: MediaStream) => {
        for (const track of stream.getVideoTracks()) {
          if (observed.has(track)) continue;
          observed.add(track);
          for (const eventName of ['mute', 'unmute', 'ended']) {
            track.addEventListener(eventName, refresh);
            listeners.push(() => track.removeEventListener(eventName, refresh));
          }
        }
      };
      for (const stream of streams) {
        observeTracks(stream);
        const onTrackChange = () => {
          observeTracks(stream);
          refresh();
        };
        stream.addEventListener('addtrack', onTrackChange);
        stream.addEventListener('removetrack', onTrackChange);
        listeners.push(() => stream.removeEventListener('addtrack', onTrackChange));
        listeners.push(() => stream.removeEventListener('removetrack', onTrackChange));
      }
      onCleanup(() => listeners.forEach((remove) => remove()));
    });

    effect(() => {
      if (this.calls.mediaUpgradeRequested()) {
        untracked(() => this.revealCallChrome());
      }
    });
  }

  ionViewWillEnter(): void {
    this.calls.clearInactiveCallUi();
    if (!this.calls.activeCall()) {
      this.resetIdleUi(false);
    }
    this.revealCallChrome();
  }

  ionViewWillLeave(): void {
    this.calls.clearInactiveCallUi();
    this.clearControlsAutoHide();
    if (!this.calls.activeCall()) {
      this.resetIdleUi(true);
    }
  }

  async startSelected(type: 'Voice' | 'Video'): Promise<void> {
    const conversation = this.chat.selectedConversation();
    if (!conversation) {
      return;
    }
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
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
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
    this.callBusyId = `${type}:${contact.userId}`;
    try {
      const conversation = await this.chat.createDirectConversation(this.contactAsPerson(contact));
      await this.calls.start(type, conversation.id, [contact.userId]);
    } finally {
      this.callBusyId = '';
    }
  }

  async accept(): Promise<void> {
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
    await this.calls.accept();
    this.revealCallChrome();
  }

  async decline(): Promise<void> {
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
    await this.calls.decline();
  }

  async endActive(): Promise<void> {
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
    await this.calls.end();
  }

  async toggleScreenShare(): Promise<void> {
    this.revealCallChrome();
    await this.calls.toggleScreenShare();
  }

  async enableVideo(): Promise<void> {
    this.revealCallChrome();
    await this.calls.enableVideo();
  }

  async acceptVideoUpgrade(): Promise<void> {
    this.revealCallChrome();
    await this.calls.acceptVideoUpgrade();
  }

  declineVideoUpgrade(): void {
    this.calls.declineVideoUpgrade();
    this.revealCallChrome();
  }

  async rejoin(callId: string): Promise<void> {
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.revealCallChrome();
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

  async inviteToCall(contact: Contact): Promise<void> {
    if (this.callBusyId) {
      return;
    }
    this.callBusyId = `invite:${contact.userId}`;
    try {
      await this.calls.inviteToCall(contact.userId);
      this.inviteModalOpen = false;
    } catch {
      this.inviteModalOpen = true;
    } finally {
      this.callBusyId = '';
    }
  }

  callInviteContacts(): Contact[] {
    const call = this.calls.activeCall();
    const excludedIds = new Set([
      this.auth.session()?.user.id,
      call?.initiatorUserId,
      ...(call?.participantUserIds ?? []),
    ].filter((userId): userId is string => Boolean(userId)));
    return this.agendaContacts().filter((contact) => !excludedIds.has(contact.userId));
  }

  contactLabel(contact: Contact): string {
    return this.profileLabel(contact) || this.tr('COMMON.CONTACT', 'Contacto');
  }

  contactSubLabel(contact: Contact): string {
    const label = this.contactLabel(contact);
    const phone = this.formatPhone(contact.phone);
    const alias = contact.alias ? `@${contact.alias}` : '';
    if (phone && label !== phone) {
      return phone;
    }
    if (alias && label !== contact.alias) {
      return alias;
    }
    return contact.bio || this.tr('CALLS.ENCRYPTED_CONTACT', 'Contacto cifrado');
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
    if (!this.calls.activeCall()) return this.tr('CALLS.READY', 'Lista para llamar');
    if (this.calls.mediaUpgradeRequested()) return this.tr('CALLS.VIDEO_REQUEST', 'Invitación a video');
    if (this.calls.mediaUpgradeAwaitingPeer()) return this.tr('CALLS.VIDEO_WAITING', 'Esperando video');
    return this.calls.callStatusLabel(this.calls.activeCall());
  }

  isCallMode(): boolean {
    const phase = this.calls.phase();
    return Boolean(this.calls.activeCall() && ['calling', 'ringing', 'connecting', 'connected', 'failed'].includes(phase));
  }

  selectedTitle(): string {
    const conversation = this.chat.selectedConversation();
    return conversation ? this.chat.conversationTitle(conversation) : this.tr('CALLS.SELECT_CHAT', 'Selecciona un chat');
  }

  historyTitle(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationTitle(conversation);
    }
    const primaryUserId = this.primaryHistoryUserId(call);
    if (primaryUserId) {
      return this.participantLabel(primaryUserId);
    }
    return call.type === 'Video' ? this.tr('CALLS.VIDEO_CALL', 'Videollamada') : this.tr('CALLS.CALL', 'Llamada');
  }

  historyPhoto(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationPhoto(conversation);
    }
    return this.participantPhoto(this.primaryHistoryUserId(call));
  }

  historyInitials(call: CallSession): string {
    return this.initials(this.historyTitle(call));
  }

  historySubtitle(call: CallSession): string {
    const kind = call.type === 'Video' ? this.tr('CALLS.VIDEO_CALL', 'Videollamada') : this.tr('CALLS.CALL', 'Llamada');
    const direction = this.historyDirectionLabel(call).toLowerCase();
    const status = this.historyStatusLabel(call.status).toLowerCase();
    return `${kind} ${direction} ${status}`;
  }

  historyStatusLabel(status: string | null | undefined): string {
    const normalized = String(status || '').toLowerCase();
    if (normalized === 'missed') {
      return this.tr('CALLS.STATUS_MISSED', 'perdida');
    }
    if (normalized === 'failed') {
      return this.tr('CALLS.STATUS_FAILED', 'fallida');
    }
    if (normalized === 'rejected') {
      return this.tr('CALLS.STATUS_REJECTED', 'rechazada');
    }
    if (normalized === 'ringing') {
      return this.tr('CALLS.STATUS_RINGING', 'sonando');
    }
    if (normalized === 'active') {
      return this.tr('CALLS.STATUS_ACTIVE', 'activa');
    }
    return this.tr('CALLS.STATUS_ENDED', 'finalizada');
  }

  historyDirectionLabel(call: CallSession): string {
    if (String(call.status || '').toLowerCase() === 'missed') {
      return this.tr('CALLS.DIRECTION_MISSED', 'perdida');
    }
    return call.initiatorUserId === this.auth.session()?.user.id ? this.tr('CALLS.DIRECTION_OUTGOING', 'saliente') : this.tr('CALLS.DIRECTION_INCOMING', 'entrante');
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

  activeCallTitle(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.calls.isGroupCall(call) ? `${this.tr('CALLS.GROUP_CALL', 'Llamada de Grupo')}: ${this.chat.conversationTitle(conversation)}` : this.chat.conversationTitle(conversation);
    }
    const labels = this.callParticipantIds(call).map((userId) => this.participantLabel(userId)).filter(Boolean);
    if (labels.length) {
      return labels.join(', ');
    }
    return this.calls.callTitle(call);
  }

  activeCallPhoto(call: CallSession): string {
    const conversation = this.conversationForCall(call);
    if (conversation) {
      return this.chat.conversationPhoto(conversation);
    }
    return this.participantPhoto(this.callParticipantIds(call)[0]);
  }

  activeCallInitials(call: CallSession): string {
    return this.initials(this.activeCallTitle(call));
  }

  videoTiles(): VideoTile[] {
    const tiles: VideoTile[] = [];
    const local = this.calls.localStream();
    if (local) {
      tiles.push({ id: this.localParticipantId(), stream: local, local: true });
    }
    this.calls.remoteEntries().forEach(([id, stream]) => {
      tiles.push({ id, stream, local: false });
    });
    return tiles;
  }

  pinnedVideoTile(): VideoTile | null {
    if (!this.pinnedParticipantId) {
      return null;
    }
    return this.videoTiles().find((tile) => tile.id === this.pinnedParticipantId) ?? null;
  }

  galleryVideoTiles(): VideoTile[] {
    const pinned = this.pinnedVideoTile();
    const tiles = this.videoTiles();
    return pinned ? tiles.filter((tile) => tile.id !== pinned.id) : tiles;
  }

  selectVideoTile(tile: VideoTile): void {
    if (this.calls.activeCall()?.type !== 'Video') {
      return;
    }
    this.pinnedParticipantId = this.pinnedParticipantId === tile.id ? null : tile.id;
    this.videoSwapped = false;
    this.revealCallChrome();
  }

  clearPinnedVideo(): void {
    this.pinnedParticipantId = null;
    this.videoSwapped = false;
    this.revealCallChrome();
  }

  videoGallerySizeClass(): 'one' | 'two' | 'four' | 'many' {
    const count = this.videoTiles().length;
    if (count <= 1) {
      return 'one';
    }
    if (count === 2) {
      return 'two';
    }
    if (count <= 4) {
      return 'four';
    }
    return 'many';
  }

  videoTileLabel(tile: VideoTile): string {
    return this.videoParticipantLabel(tile.id);
  }

  primaryRemoteEntry(): RemoteEntry | null {
    return this.calls.remoteEntries()[0] ?? null;
  }

  extraRemoteEntries(): RemoteEntry[] {
    return this.calls.remoteEntries().slice(1);
  }

  mainVideoStream(): MediaStream | null {
    const remote = this.primaryRemoteEntry()?.[1] ?? null;
    const local = this.calls.localStream();
    return this.videoSwapped ? local : remote;
  }

  mainVideoParticipantId(): string {
    const remoteId = this.primaryRemoteParticipantId();
    return this.videoSwapped ? this.localParticipantId() : remoteId;
  }

  pipVideoStream(): MediaStream | null {
    const remote = this.primaryRemoteEntry()?.[1] ?? null;
    const local = this.calls.localStream();
    return this.videoSwapped ? remote : local;
  }

  pipVideoParticipantId(): string {
    const remoteId = this.primaryRemoteParticipantId();
    return this.videoSwapped ? remoteId : this.localParticipantId();
  }

  videoFallbackStatus(userId: string | null | undefined): string {
    if (this.isScreenVideoParticipant(userId)) {
      return this.tr('CALLS.SCREEN_STARTING', 'Conectando la pantalla compartida…');
    }
    if (this.isLocalParticipant(this.baseParticipantId(userId))) {
      return this.calls.cameraOff()
        ? this.tr('CALLS.YOUR_CAMERA_OFF', 'Tu cámara está apagada')
        : this.tr('CALLS.STARTING_CAMERA', 'Activando tu cámara…');
    }
    if (this.calls.mediaUpgradeAwaitingPeer()) {
      return this.tr('CALLS.WAITING_FOR_PEER_CAMERA', 'Esperando que active su cámara…');
    }
    if (this.calls.mediaUpgradeRequested()) {
      return this.tr('CALLS.VIDEO_REQUEST_PENDING', 'Tu contacto te invitó a activar el video');
    }
    if (this.calls.mediaUpgradeNotice()) {
      return this.calls.mediaUpgradeNotice();
    }
    const baseId = this.baseParticipantId(userId);
    if (baseId && this.calls.remoteStates()[baseId]?.['camera'] === 'off') {
      return this.tr('CALLS.PEER_CAMERA_OFF', 'Su cámara está apagada');
    }
    return this.tr('CALLS.PEER_CAMERA_UNAVAILABLE', 'Cámara apagada o conectando…');
  }

  toggleVideoSwap(): void {
    if (this.calls.activeCall()?.type !== 'Video' || !this.primaryRemoteEntry() || !this.calls.localStream()) {
      return;
    }
    this.videoSwapped = !this.videoSwapped;
    this.revealCallChrome();
  }

  revealCallChrome(): void {
    this.controlsVisible = true;
    this.armControlsAutoHide();
  }

  gameUserId(): string { return this.auth.session()?.user.id ?? ''; }

  gameParticipants(): Array<{ userId: string; label: string }> {
    return Object.keys(this.calls.activeCall()?.participantSessions ?? {}).map(userId => ({ userId, label: this.videoParticipantLabel(userId) }));
  }

  toggleGames(): void {
    if (this.calls.games.panelOpen()) this.calls.games.leaveGame(true);
    else this.calls.games.panelOpen.set(true);
    this.revealCallChrome();
  }

  videoParticipantLabel(userId: string | null | undefined): string {
    const baseId = this.baseParticipantId(userId);
    const label = this.isLocalParticipant(baseId) ? this.participantLabel(this.auth.session()?.user.id) : this.participantLabel(baseId);
    return this.isScreenVideoParticipant(userId)
      ? `${label} - ${this.tr('CALLS.SCREEN_SHARE', 'Pantalla compartida')}`
      : label;
  }

  videoParticipantPhoto(userId: string | null | undefined): string {
    const baseId = this.baseParticipantId(userId);
    return this.isLocalParticipant(baseId) ? this.participantPhoto(this.auth.session()?.user.id) : this.participantPhoto(baseId);
  }

  videoParticipantInitials(userId: string | null | undefined): string {
    return this.initials(this.videoParticipantLabel(userId));
  }

  videoMuted(userId: string | null | undefined): boolean {
    return this.isLocalParticipant(this.baseParticipantId(userId)) || !this.calls.speaker();
  }

  audioMuted(userId: string | null | undefined): boolean {
    return this.isLocalParticipant(this.baseParticipantId(userId)) || !this.calls.speaker();
  }

  hasVideoTrack(stream: MediaStream | null | undefined): boolean {
    this.videoTrackRevision();
    return Boolean(stream?.getVideoTracks().some((track) => track.readyState === 'live' && track.enabled && !track.muted));
  }

  videoParticipantHasVideo(stream: MediaStream | null | undefined, userId: string | null | undefined): boolean {
    if (!this.isScreenVideoParticipant(userId)) {
      const baseId = this.baseParticipantId(userId);
      if (this.isLocalParticipant(baseId) && this.calls.cameraOff()) {
        return false;
      }
      if (baseId && this.calls.remoteStates()[baseId]?.['camera'] === 'off') {
        return false;
      }
    }
    return this.hasVideoTrack(stream);
  }

  hasAudioTrack(stream: MediaStream | null | undefined): boolean {
    return Boolean(stream?.getAudioTracks().length);
  }

  canControlLocalMedia(): boolean {
    const call = this.calls.activeCall();
    return Boolean(this.calls.localStream() || (call && this.calls.isGroupCall(call) && this.calls.phase() === 'connected'));
  }

  private resetIdleUi(clearSearch: boolean): void {
    this.callBusyId = '';
    this.inviteModalOpen = false;
    this.videoSwapped = false;
    this.pinnedParticipantId = null;
    this.controlsVisible = true;
    this.clearControlsAutoHide();
    if (clearSearch) {
      this.callQuery = '';
    }
  }

  private armControlsAutoHide(): void {
    this.clearControlsAutoHide();
    if (!this.isCallMode() || this.calls.phase() !== 'connected' || this.calls.games.panelOpen() || this.calls.mediaUpgradeRequested()) {
      return;
    }
    this.controlsHideTimer = window.setTimeout(() => {
      const phase = this.calls.phase();
      if (this.isCallMode() && phase === 'connected') {
        this.controlsVisible = false;
      }
    }, 5000);
  }

  private clearControlsAutoHide(): void {
    if (this.controlsHideTimer !== null) {
      window.clearTimeout(this.controlsHideTimer);
      this.controlsHideTimer = null;
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
      allowStoryReposts: true,
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
      isMutualContact: false,
      createdAt: participant.joinedAt || new Date().toISOString(),
    };
  }

  private conversationForCall(call: CallSession): Conversation | null {
    const conversationId = call.conversationId || call.groupId;
    return conversationId ? this.chat.conversations().find((conversation) => conversation.id === conversationId) ?? null : null;
  }

  private callParticipantIds(call: CallSession): string[] {
    const currentUserId = this.auth.session()?.user.id;
    return [...new Set([call.initiatorUserId, ...(call.participantUserIds ?? [])])]
      .filter((userId): userId is string => Boolean(userId && userId !== currentUserId));
  }

  private primaryHistoryUserId(call: CallSession): string | null {
    const currentUserId = this.auth.session()?.user.id;
    const ids = [call.initiatorUserId, ...(call.participantUserIds ?? [])]
      .filter((userId): userId is string => Boolean(userId && userId !== currentUserId));
    return [...new Set(ids)][0] ?? null;
  }

  private participantLabel(userId: string | null | undefined): string {
    const currentUser = this.auth.session()?.user;
    const profile = this.profileForUser(userId);
    const label = this.profileLabel(profile) || this.chat.participantDisplayName(userId, profile);
    if (userId && currentUser?.id === userId) {
      return label && label !== this.tr('COMMON.CONTACT', 'Contacto') ? `${label} (${this.tr('COMMON.YOU', 'Tu')})` : this.tr('COMMON.YOU', 'Tu');
    }
    return label || this.tr('COMMON.CONTACT', 'Contacto');
  }

  private participantPhoto(userId: string | null | undefined): string {
    const profile = this.profileForUser(userId);
    return profile?.profilePhotoDataUrl || this.chat.participantPhoto(userId, profile);
  }

  private profileForUser(userId: string | null | undefined): CallIdentityProfile | null {
    if (!userId) {
      return null;
    }
    const currentUser = this.auth.session()?.user;
    if (currentUser?.id === userId) {
      return {
        userId: currentUser.id,
        id: currentUser.id,
        alias: currentUser.alias,
        displayName: currentUser.displayName,
        phone: currentUser.phone,
        profilePhotoDataUrl: currentUser.profilePhotoDataUrl,
      };
    }
    return this.chat.contacts().find((contact) => contact.userId === userId)
      || this.chat.conversations()
        .flatMap((conversation) => conversation.participants)
        .find((participant) => participant.userId === userId)
      || null;
  }

  private profileLabel(profile: CallIdentityProfile | null | undefined): string {
    return this.firstText(profile?.displayName, profile?.alias, this.formatPhone(profile?.phone));
  }

  private localParticipantId(): string {
    return this.auth.session()?.user.id || 'local';
  }

  private primaryRemoteParticipantId(): string {
    const call = this.calls.activeCall();
    return this.primaryRemoteEntry()?.[0] || (call ? this.callParticipantIds(call)[0] : '') || '';
  }

  private baseParticipantId(userId: string | null | undefined): string | null | undefined {
    return this.isScreenShareTileId(userId) ? userId?.replace(/:screen$/, '') : userId;
  }

  private isScreenShareTileId(userId: string | null | undefined): boolean {
    return typeof userId === 'string' && userId.endsWith(':screen');
  }

  private isScreenVideoParticipant(userId: string | null | undefined): boolean {
    if (this.isScreenShareTileId(userId)) {
      return true;
    }
    const call = this.calls.activeCall();
    if (!call || this.calls.isGroupCall(call)) {
      return false;
    }
    const baseId = this.baseParticipantId(userId);
    return this.isLocalParticipant(baseId)
      ? this.calls.screenSharing()
      : Boolean(baseId && this.calls.remoteStates()[baseId]?.['screen'] === 'on');
  }

  private isLocalParticipant(userId: string | null | undefined): boolean {
    const currentUserId = this.auth.session()?.user.id;
    return !userId || userId === 'local' || Boolean(currentUserId && userId === currentUserId);
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

  private firstText(...values: Array<string | null | undefined>): string {
    return values.map((value) => (value || '').trim()).find(Boolean) || '';
  }

  private formatPhone(value: string | null | undefined): string {
    const raw = (value || '').trim();
    const digits = raw.replace(/[^\d+]/g, '');
    if (!digits) {
      return '';
    }
    if (digits.startsWith('+') && digits.length > 8) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}${digits.length > 10 ? ` ${digits.slice(10)}` : ''}`.trim();
    }
    if (/^\d{10}$/.test(digits)) {
      return `${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6)}`;
    }
    return raw;
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }
}
