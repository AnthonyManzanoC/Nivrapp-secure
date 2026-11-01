// Separate build entry: NEVER imported by src/main.ts or shipped in production.
// Renders the actual shell/chats components with synthetic, network-free services.
import { Component, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterLink, RouterOutlet } from '@angular/router';
import { IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonContent, provideIonicAngular } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBackOutline, callOutline, videocamOutline } from 'ionicons/icons';
import { ShellPage } from '../src/app/features/shell/shell.page';
import { ChatsPage } from '../src/app/features/chats/chats.page';
import { AuthService } from '../src/app/core/services/auth.service';
import { ChatService } from '../src/app/core/services/chat.service';
import { SocialService } from '../src/app/core/services/social.service';
import { CallsService } from '../src/app/core/services/calls.service';
import { SignalrService } from '../src/app/core/services/signalr.service';
import { AppSettingsService } from '../src/app/core/services/app-settings.service';
import { LocalHistoryService } from '../src/app/core/services/local-history.service';
import { NativeDeviceService } from '../src/app/core/services/native-device.service';
import { TranslateService } from '../src/app/core/services/translate.service';
import { PushService } from '../src/app/core/services/push.service';
import { PrivateChatLockService } from '../src/app/core/services/private-chat-lock.service';
import { AppLockService } from '../src/app/core/services/app-lock.service';
import { UnreadTabService } from '../src/app/core/services/unread-tab.service';
import { ClientCompatibilityService } from '../src/app/core/services/client-compatibility.service';
import { NivraApiService } from '../src/app/core/services/nivra-api.service';

const user = { id: 'preview-owner', alias: 'alex', displayName: 'Alex', profilePhotoDataUrl: null };
const items = signal<any[]>([
  { id: 'design', name: 'Estudio Creativo', preview: 'La nueva propuesta está lista ✨', type: 'Group', pinned: true, unread: true },
  { id: 'sofia', name: 'Sofía Martínez', preview: 'Nos vemos a las seis. ¡Qué ganas!', type: 'Direct', unread: true },
  { id: 'family', name: 'Familia', preview: 'Mamá: Les comparto las fotos del viaje', type: 'Group' },
  { id: 'daniel', name: 'Daniel Ruiz', preview: 'Gracias por la llamada de hoy.', type: 'Direct' },
  { id: 'weekend', name: 'Planes del finde', preview: 'Tú: Ese lugar se ve increíble', type: 'Group', muted: true },
  { id: 'valentina', name: 'Valentina', preview: 'Nota de voz · 0:24', type: 'Direct' },
  { id: 'empty', name: 'Contacto de prueba', preview: 'Cifrado extremo a extremo', type: 'Direct' },
  { id: 'archive', name: 'Proyecto anterior', preview: 'Todo entregado, gracias equipo.', type: 'Group', archived: true },
].map((item, i) => ({ ...item, participants: [{ userId: user.id }, { userId: 'peer-' + i, alias: item.id, displayName: item.name }], updatedAt: `2026-10-31T14:${String(42 - i * 3).padStart(2, '0')}:00Z` })));
const mutate = (item: any, key: string, value: boolean) => { items.update(all => all.map(row => row.id === item.id ? { ...row, [key]: value } : row)); return Promise.resolve(); };
const chat: any = {
  conversations: items, contacts: signal([]), messagesByConversation: signal({}), selectedConversationId: signal(null),
  loading: signal(false), listUpdating: signal(false), syncError: signal(''), localHistoryCheckState: signal('idle'),
  deviceHistory: { state: signal('idle'), recoveryStatus: signal('approval'), targetFingerprint: signal('fixture') },
  chatFolderConversations: (folder: string) => items().filter(item => folder === 'archived' ? item.archived : !item.archived && (folder === 'pinned' ? item.pinned : folder === 'unread' ? item.unread : true)),
  conversationTitle: (item: any) => item.name, conversationSubtitle: (item: any) => item.preview, conversationPhoto: () => null,
  avatarLabel: (item: any) => item.name.split(' ').map((word: string) => word[0]).slice(0, 2).join(''),
  conversationIsNivraId: () => false,
  hasUnreadConversation: (item: any) => !!item.unread,
  isGroup: (item: any) => item.type === 'Group', profileSummary: (profile: any) => profile,
  isConversationPinned: (id: string) => !!items().find(item => item.id === id)?.pinned,
  isConversationMuted: (id: string) => !!items().find(item => item.id === id)?.muted,
  isConversationArchived: (id: string) => !!items().find(item => item.id === id)?.archived,
  setConversationPinned: (item: any, value: boolean) => mutate(item, 'pinned', value),
  setConversationMuted: (item: any, value: boolean) => mutate(item, 'muted', value),
  setConversationArchived: (item: any, value: boolean) => mutate(item, 'archived', value),
  clearSelectedConversation: () => chat.selectedConversationId.set(null), searchPeople: async () => [],
  selectConversation: async (id: string) => chat.selectedConversationId.set(id),
  refreshChats: async () => true, presenceLabel: (item: any) => item.id === 'empty' ? 'cifrado extremo a extremo' : item.type === 'Group' ? '3 participantes' : 'online', checkLocalHistory: async () => {},
  conversationListPresence: (item: any) => ChatService.prototype.conversationListPresence.call(chat, item),
};
const previewSettings = signal({ chatListDensity: 'three-line' });
@Component({
  selector: 'app-chat-detail', standalone: true,
  imports: [RouterLink, IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonContent],
  styleUrls: ['../src/app/features/chat-detail/chat-detail.page.scss'],
  template: `<section class="chat-detail ion-page"><ion-header class="chat-header"><ion-toolbar>
    <ion-buttons slot="start" class="chat-back-controls"><ion-button class="mobile-back" fill="clear" routerLink="/app/chats" aria-label="Volver"><ion-icon name="arrow-back-outline" /></ion-button></ion-buttons>
    <button type="button" class="title-wrap"><span class="avatar">S</span><div><h1>Sofía · Datos ficticios</h1><p>online</p></div></button>
    <ion-buttons slot="end"><ion-button aria-label="Llamar"><ion-icon name="call-outline" /></ion-button><ion-button aria-label="Video"><ion-icon name="videocam-outline" /></ion-button></ion-buttons>
    </ion-toolbar></ion-header><ion-content class="messages-content"><div class="messages"><p class="system-message">Vista de diseño: ningún mensaje real</p></div></ion-content></section>`,
})
class PreviewConversation {
  constructor() { addIcons({ arrowBackOutline, callOutline, videocamOutline }); }
}

@Component({ selector: 'preview-empty', standalone: true, template: '<section style="padding:40px;color:var(--nivra-text)"><h1>Vista de prueba</h1><p>Esta vista usa datos ficticios y no envía mensajes.</p><a href="/app/chats">Volver a Chats</a></section>' })
class PreviewEmpty {}
@Component({
  selector: 'app-root', standalone: true, imports: [RouterOutlet],
  template: `<router-outlet /><aside class="preview-controls"><span>Vista de prueba · Datos ficticios</span><button type="button" (click)="toggleDensity()">Cambiar líneas</button><button type="button" (click)="toggleTheme()">{{ light ? 'Tema oscuro' : 'Tema claro' }}</button></aside>`,
  styles: ['.preview-controls{position:fixed;right:20px;bottom:14px;z-index:100;display:flex;gap:12px;align-items:center;padding:8px 12px;background:var(--nivra-panel-solid);color:var(--nivra-muted);border:1px solid var(--nivra-line);border-radius:12px;font-size:11px}.preview-controls button{background:none;color:var(--nivra-brand-2);border:0;min-height:32px;cursor:pointer}@media(max-width:768px){.preview-controls{bottom:72px;font-size:9px;right:8px;padding:4px 8px}}'],
})
class PreviewRoot {
  light = new URLSearchParams(location.search).get('theme') === 'light';
  constructor() { this.applyTheme(); }
  toggleTheme() { this.light = !this.light; this.applyTheme(); }
  toggleDensity() { previewSettings.update(value => ({ chatListDensity: value.chatListDensity === 'three-line' ? 'two-line' : 'three-line' })); }
  private applyTheme() { for (const root of [document.documentElement, document.body]) { root.classList.toggle('nivra-light-theme', this.light); root.classList.toggle('ion-palette-dark', !this.light); } }
}

bootstrapApplication(PreviewRoot, { providers: [
  provideIonicAngular(), provideRouter([{ path: 'app', component: ShellPage, children: [
    { path: 'chats', component: ChatsPage, children: [{ path: ':id', component: PreviewConversation }] },
    { path: '**', component: PreviewEmpty },
  ] }, { path: '**', redirectTo: 'app/chats' }]),
  { provide: AuthService, useValue: { session: signal({ user, device: { id: 'preview-device', isTrusted: true } }), savedAccounts: signal([]), accountsBusy: signal(false), addingAccount: signal(false), deviceIdentityError: signal(''), deviceIdentityNeedsRelink: signal(false), isAuthenticated: () => true, logout: async () => {} } },
  { provide: ChatService, useValue: chat },
  { provide: SocialService, useValue: { stories: signal([]), worldStories: signal([]), activeStory: signal(null), storyViewerOwner: signal(null), load: async () => {}, activeStoriesForGroup: () => [], activeStoriesForOwner: () => [] } },
  { provide: CallsService, useValue: { activeCall: signal(null), resumableCall: signal(null), phase: signal('idle'), audioOutput: { playbackBlocked: signal(false) } } },
  { provide: SignalrService, useValue: { connected: signal(true) } },
  { provide: UnreadTabService, useValue: { unreadChats: signal(2) } },
  { provide: AppLockService, useValue: { isContentLocked: signal(false) } },
  { provide: PrivateChatLockService, useValue: { isProtected: () => false } },
  { provide: ClientCompatibilityService, useValue: { check: async () => {}, updateRequired: signal(false) } },
  { provide: NivraApiService, useValue: { baseUrl: '' } },
  { provide: AppSettingsService, useValue: { settings: previewSettings } },
  { provide: LocalHistoryService, useValue: { storageError: signal(''), storageState: signal('ready'), storageBusy: signal(false) } },
  { provide: NativeDeviceService, useValue: {} },
  { provide: PushService, useValue: { permission: signal('unsupported'), registering: signal(false) } },
  { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: signal('es') } },
] }).catch(error => console.error(error));
