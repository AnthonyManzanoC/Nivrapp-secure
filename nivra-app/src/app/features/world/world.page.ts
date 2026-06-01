import { CommonModule, DatePipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  addOutline,
  chatbubbleEllipsesOutline,
  checkmarkOutline,
  closeOutline,
  documentAttachOutline,
  eyeOutline,
  imageOutline,
  personAddOutline,
  personRemoveOutline,
  refreshOutline,
  searchOutline,
  sendOutline,
  star,
  starOutline,
  timeOutline,
  trashOutline,
} from 'ionicons/icons';
import { Contact, Story, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { SocialService } from '../../core/services/social.service';
import { Router } from '@angular/router';

@Component({
  selector: 'app-world',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule, IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea],
  templateUrl: './world.page.html',
  styleUrls: ['./world.page.scss'],
})
export class WorldPage implements OnInit, OnDestroy {
  readonly social = inject(SocialService);
  readonly auth = inject(AuthService);
  readonly chat = inject(ChatService);
  private readonly router = inject(Router);
  query = '';
  storyText = '';
  visibility = 'Contacts';
  durationSeconds = 24 * 60 * 60;
  viewOnce = false;
  storyFile: File | null = null;
  busyId = '';
  error = '';
  notice = '';
  private timer: number | null = null;

  constructor() {
    addIcons({
      addOutline,
      chatbubbleEllipsesOutline,
      checkmarkOutline,
      closeOutline,
      documentAttachOutline,
      eyeOutline,
      imageOutline,
      personAddOutline,
      personRemoveOutline,
      refreshOutline,
      searchOutline,
      sendOutline,
      star,
      starOutline,
      timeOutline,
      trashOutline,
    });
  }

  async ngOnInit(): Promise<void> {
    await this.social.load();
  }

  ngOnDestroy(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
  }

  searchChanged(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(() => void this.social.search(this.query), 300);
  }

  storyFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.storyFile = input.files?.[0] ?? null;
    input.value = '';
  }

  clearStoryFile(): void {
    this.storyFile = null;
  }

  async request(person: UserSummary): Promise<void> {
    await this.run(person.id, async () => {
      await this.social.requestFriend(person);
      this.notice = 'Solicitud enviada.';
    });
  }

  async addContact(person: UserSummary): Promise<void> {
    await this.run(`contact:${person.id}`, async () => {
      await this.social.addContact(person);
      this.notice = 'Contacto guardado.';
    });
  }

  async openPerson(person: UserSummary): Promise<void> {
    await this.run(`open:${person.id}`, async () => {
      await this.chat.createDirectConversation(person);
      await this.router.navigateByUrl(`/app/chats/${this.chat.selectedConversationId()}`);
    });
  }

  async openContact(contact: Contact): Promise<void> {
    await this.openPerson(this.contactAsPerson(contact));
  }

  async toggleFavorite(contact: Contact): Promise<void> {
    await this.run(`favorite:${contact.userId}`, () => this.social.toggleFavorite(contact));
  }

  async deleteContact(contact: Contact): Promise<void> {
    if (!window.confirm(`Eliminar @${contact.alias} de tus contactos?`)) {
      return;
    }
    await this.run(`remove:${contact.userId}`, async () => {
      await this.social.deleteContact(contact);
      this.notice = 'Contacto eliminado.';
    });
  }

  async accept(id: string): Promise<void> {
    await this.run(id, () => this.social.accept(id));
  }

  async reject(id: string): Promise<void> {
    await this.run(id, () => this.social.reject(id));
  }

  async cancel(id: string): Promise<void> {
    await this.run(id, () => this.social.cancel(id));
  }

  async publishStory(): Promise<void> {
    const text = this.storyText.trim();
    if (!text && !this.storyFile) {
      return;
    }
    await this.run('story', async () => {
      await this.social.publishStory({
        text,
        visibility: this.visibility,
        file: this.storyFile,
        durationSeconds: Number(this.durationSeconds),
        viewOnce: this.viewOnce,
      });
      this.storyText = '';
      this.storyFile = null;
      this.viewOnce = false;
      this.notice = 'Historia publicada.';
    });
  }

  async openStory(story: Story): Promise<void> {
    await this.run(`story:${story.id}`, () => this.social.viewStory(story));
  }

  async deleteStory(story: Story): Promise<void> {
    await this.run(`delete:${story.id}`, async () => {
      await this.social.deleteStory(story);
      this.notice = 'Historia eliminada.';
    });
  }

  isMine(story: Story): boolean {
    return story.owner.id === this.auth.session()?.user.id;
  }

  contactAsPerson(contact: Contact): UserSummary {
    return {
      id: contact.userId,
      alias: contact.alias,
      displayName: contact.displayName,
      profilePhotoDataUrl: contact.profilePhotoDataUrl,
      bio: null,
      isDiscoverable: true,
      isContact: true,
      isMutualContact: true,
      isFavorite: contact.isFavorite,
      friendshipState: 'friends',
    };
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
