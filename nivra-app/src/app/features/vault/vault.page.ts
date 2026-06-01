import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addCircleOutline,
  attachOutline,
  checkmarkCircleOutline,
  cloudDownloadOutline,
  enterOutline,
  keyOutline,
  lockClosedOutline,
  logOutOutline,
  peopleOutline,
  refreshOutline,
  searchOutline,
  sendOutline,
  shieldCheckmarkOutline,
  trashOutline,
} from 'ionicons/icons';
import { FileChatPayload, UserSummary, VaultRoom, VaultRoomMember, VaultRoomMessageVm } from '../../core/models/nivra.models';
import { VaultService } from '../../core/services/vault.service';

@Component({
  selector: 'app-vault',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea],
  templateUrl: './vault.page.html',
  styleUrls: ['./vault.page.scss'],
})
export class VaultPage implements OnInit, OnDestroy {
  readonly vault = inject(VaultService);
  pin = '';
  title = '';
  body = '';
  roomName = '';
  roomPin = '';
  roomAccessMode = 'PinOnly';
  retentionMode = 'Persistent';
  inviteQuery = '';
  roomMessage = '';
  busyId = '';
  error = '';
  notice = '';
  roomPinById: Record<string, string> = {};
  selectedInviteIds = new Set<string>();
  private searchTimer: number | null = null;

  constructor() {
    addIcons({
      addCircleOutline,
      attachOutline,
      checkmarkCircleOutline,
      cloudDownloadOutline,
      enterOutline,
      keyOutline,
      lockClosedOutline,
      logOutOutline,
      peopleOutline,
      refreshOutline,
      searchOutline,
      sendOutline,
      shieldCheckmarkOutline,
      trashOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    await this.vault.load();
  }

  ngOnDestroy(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
    }
  }

  async unlock(): Promise<void> {
    await this.run('unlock', async () => {
      await this.vault.unlock(this.pin);
      this.pin = '';
      this.notice = 'Boveda desbloqueada.';
    });
  }

  async createNote(): Promise<void> {
    await this.run('note', async () => {
      await this.vault.createNote(this.title || 'Nota privada', this.body);
      this.title = '';
      this.body = '';
      this.notice = 'Nota cifrada guardada.';
    });
  }

  async createRoom(): Promise<void> {
    await this.run('room:create', async () => {
      const room = await this.vault.createRoom({
        name: this.roomName || 'Boveda Nivra',
        pin: this.roomPin,
        accessMode: this.roomAccessMode,
        retentionMode: this.retentionMode,
        invitedUserIds: [...this.selectedInviteIds],
        ttlSeconds: 3600,
      });
      this.roomName = '';
      this.roomPin = '';
      this.inviteQuery = '';
      this.selectedInviteIds.clear();
      this.vault.people.set([]);
      this.notice = `Sala ${room.name} lista.`;
    });
  }

  async deleteItem(id: string): Promise<void> {
    await this.run(`item:${id}`, () => this.vault.deleteItem(id));
  }

  searchInvites(): void {
    if (this.searchTimer !== null) {
      window.clearTimeout(this.searchTimer);
    }
    this.searchTimer = window.setTimeout(() => void this.vault.searchPeople(this.inviteQuery), 280);
  }

  toggleInvite(person: UserSummary): void {
    if (this.selectedInviteIds.has(person.id)) {
      this.selectedInviteIds.delete(person.id);
    } else {
      this.selectedInviteIds.add(person.id);
    }
  }

  inviteSelected(person: UserSummary): boolean {
    return this.selectedInviteIds.has(person.id);
  }

  async openRoom(room: VaultRoom): Promise<void> {
    if (this.vault.currentMember(room)?.status === 'Active') {
      await this.run(`room:${room.id}`, async () => {
        await this.vault.selectRoom(room.id);
        this.notice = 'Sala Vault abierta.';
      });
      return;
    }
    await this.joinRoom(room);
  }

  async joinRoom(room: VaultRoom): Promise<void> {
    await this.run(`join:${room.id}`, async () => {
      const joined = await this.vault.joinRoom(room, this.roomPinById[room.id] || null);
      const member = this.vault.currentMember(joined);
      this.roomPinById[room.id] = '';
      this.notice = member?.status === 'Waiting' ? 'Solicitud enviada al propietario.' : 'Boveda abierta.';
    });
  }

  async leaveRoom(room: VaultRoom): Promise<void> {
    await this.run(`leave:${room.id}`, async () => {
      await this.vault.leaveRoom(room.id);
      this.notice = 'Saliste de la sala.';
    });
  }

  async inviteActiveRoom(): Promise<void> {
    const room = this.vault.activeRoom();
    if (!room) {
      return;
    }
    await this.run(`invite:${room.id}`, async () => {
      await this.vault.inviteUsers(room.id, [...this.selectedInviteIds]);
      this.selectedInviteIds.clear();
      this.inviteQuery = '';
      this.vault.people.set([]);
      this.notice = 'Invitaciones enviadas.';
    });
  }

  async approve(room: VaultRoom, member: VaultRoomMember): Promise<void> {
    await this.run(`approve:${member.userId}`, async () => {
      await this.vault.approveMember(room.id, member.userId);
      this.notice = 'Acceso aprobado.';
    });
  }

  async sendMessage(): Promise<void> {
    await this.run('vault:send', async () => {
      await this.vault.sendRoomText(this.roomMessage);
      this.roomMessage = '';
    });
  }

  async fileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file) {
      return;
    }
    await this.run('vault:file', async () => {
      await this.vault.sendRoomFile(file);
      this.notice = 'Archivo cifrado enviado.';
    });
  }

  async previewFile(payload: FileChatPayload): Promise<void> {
    await this.run(`preview:${payload.fileId || payload.downloadFile || ''}`, () => this.vault.ensureMediaPreview(payload).then(() => undefined));
  }

  async downloadFile(payload: FileChatPayload): Promise<void> {
    await this.run(`download:${payload.fileId || payload.downloadFile || ''}`, () => this.vault.downloadAttachment(payload));
  }

  messageFile(message: VaultRoomMessageVm): FileChatPayload | null {
    return this.vault.asFile(message.payload);
  }

  initials(room: VaultRoom): string {
    return room.name.split(/\s|-/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join('') || 'NV';
  }

  activeMembers(room: VaultRoom | null): VaultRoomMember[] {
    return (room?.members ?? []).filter((member) => member.status === 'Active');
  }

  waitingMembers(room: VaultRoom | null): VaultRoomMember[] {
    return (room?.members ?? []).filter((member) => member.status === 'Waiting');
  }

  isBusy(id: string): boolean {
    return this.busyId === id;
  }

  private async run(id: string, action: () => Promise<void>): Promise<void> {
    this.busyId = id;
    this.error = '';
    this.notice = '';
    try {
      await action();
    } catch (error) {
      this.error = error instanceof Error ? error.message : 'No se pudo completar la accion.';
    } finally {
      this.busyId = '';
    }
  }
}
