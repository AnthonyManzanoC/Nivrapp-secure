// Separate build entry: NEVER imported by src/main.ts or shipped in production.
// Renders the actual shell/chats components with synthetic, network-free services.
import { GuidePage } from '../src/app/features/guide/guide.page';
import { NotificationCheckPage } from '../src/app/features/guide/notification-check.page';
import { Component, inject, signal } from '@angular/core';
import { of } from 'rxjs';
import { bootstrapApplication } from '@angular/platform-browser';
import { provideRouter, RouterLink, RouterOutlet } from '@angular/router';
import { IonModal, IonInput, IonTextarea, IonHeader, IonToolbar, IonButtons, IonButton, IonIcon, IonContent, provideIonicAngular } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { arrowBackOutline, callOutline, videocamOutline } from 'ionicons/icons';
import { ShellPage } from '../src/app/features/shell/shell.page';
import { ContactsPage } from '../src/app/features/contacts/contacts.page';
import { WorldPage } from '../src/app/features/world/world.page';
import { StoryComposerComponent } from '../src/app/shared/story-composer/story-composer.component';
import { StoryViewerComponent } from '../src/app/features/story-viewer/story-viewer.component';
import { CallGameInvitationComponent } from '../src/app/shared/call-game-invitation.component';
import { TransientNoticeDirective } from '../src/app/shared/transient-notice.directive';
import { CallGamePanelComponent } from '../src/app/shared/call-game-panel.component';
import { CallGameKind, CallGameState, applyCallGameAction, createCallGame } from '../src/app/core/games/call-game-engine';
import { ContactSyncService } from '../src/app/core/services/contact-sync.service';
import { ChatsPage } from '../src/app/features/chats/chats.page';
import { AuthService } from '../src/app/core/services/auth.service';
import { ChatService } from '../src/app/core/services/chat.service';
import { SocialService } from '../src/app/core/services/social.service';
import { CallsService } from '../src/app/core/services/calls.service';
import { AccountIdentityService } from '../src/app/core/services/account-identity.service';
import { AccountIdentityRecoveryComponent } from '../src/app/features/account/account-identity-recovery.component';
import { CallsPage } from '../src/app/features/calls/calls.page';
import { CallTranslationService } from '../src/app/core/services/call-translation.service';
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
import { CommunityService } from '../src/app/core/services/community.service';
import { CommunitiesPage } from '../src/app/features/communities/communities.page';
import { VaultPage } from '../src/app/features/vault/vault.page';
import { VaultService } from '../src/app/core/services/vault.service';
import { DeviceWipeService } from '../src/app/core/services/device-wipe.service';
import { PanicPinService } from '../src/app/core/services/panic-pin.service';
import { v9Fixtures } from './v9-fixtures';

const previewAvatar = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#addbd0"/><circle cx="50" cy="37" r="18" fill="#275c55"/><ellipse cx="50" cy="102" rx="40" ry="45" fill="#275c55"/></svg>');
const user = { id: 'preview-owner', alias: 'alex', displayName: 'Alex', profilePhotoDataUrl: previewAvatar };
const v9=v9Fixtures(user,previewAvatar);
const items = signal<any[]>([
  { id: 'design', name: 'Estudio Creativo', preview: 'La nueva propuesta está lista ✨', type: 'Group', pinned: true, unread: true },
  { id: 'sofia', name: 'Sofía Martínez', preview: 'Nos vemos a las seis. ¡Qué ganas!', type: 'Direct', unread: true },
  { id: 'family', name: 'Familia', preview: 'Mamá: Les comparto las fotos del viaje', type: 'Group' },
  { id: 'community-preview', name: 'Barrio Las Flores', preview: 'Encuentro del barrio este sábado', type: 'Group', unread: true },
  { id: 'daniel', name: 'Daniel Ruiz', preview: 'Gracias por la llamada de hoy.', type: 'Direct' },
  { id: 'weekend', name: 'Planes del finde', preview: 'Tú: Ese lugar se ve increíble', type: 'Group', muted: true },
  { id: 'valentina', name: 'Valentina', preview: 'Nota de voz · 0:24', type: 'Direct' },
  { id: 'empty', name: 'Contacto de prueba', preview: 'Cifrado extremo a extremo', type: 'Direct' },
  { id: 'archive', name: 'Proyecto anterior', preview: 'Todo entregado, gracias equipo.', type: 'Group', archived: true },
].map((item, i) => ({ ...item, participants: [{ userId: user.id,role:"Owner" }, { userId: 'peer-' + i, alias: item.id, displayName: item.name }], updatedAt: `2026-10-31T14:${String(42 - i * 3).padStart(2, '0')}:00Z` })));
const mutate = (item: any, key: string, value: boolean) => { items.update(all => all.map(row => row.id === item.id ? { ...row, [key]: value } : row)); return Promise.resolve(); };
const chat: any = {
  conversations: items, contacts: signal([]), messagesByConversation: signal({}), selectedConversationId: signal(null),
  loading: signal(false), listUpdating: signal(false), syncError: signal(''), localHistoryCheckState: signal('idle'),
  deviceHistory: { state: signal('idle'), recoveryStatus: signal('approval'), targetFingerprint: signal('fixture') },
  chatFolderConversations: (folder: string) => items().filter(item => folder === 'archived' ? item.archived : !item.archived && (folder === 'pinned' ? item.pinned : folder === 'unread' ? item.unread : true)),
  conversationTitle: (item: any) => item.name, conversationSubtitle: (item: any) => item.preview, conversationPhoto: (item:any) => item?.id==='design'?previewAvatar:null,
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
  deleteConversation: async (item: any, scope: string) => {
    if (scope !== 'me') throw Error('Bulk delete must use the current account');
    items.update(all => all.filter(row => row.id !== item.id));
  },
  clearSelectedConversation: () => chat.selectedConversationId.set(null), searchPeople: async () => [],
  selectConversation: async (id: string) => chat.selectedConversationId.set(id),
  refreshChats: async () => true, presenceLabel: (item: any) => item.id === 'empty' ? 'cifrado extremo a extremo' : item.type === 'Group' ? '3 participantes' : 'online', checkLocalHistory: async () => {},
  hydrateConversationProfile:async()=>{},canSendToConversation:()=>true,isConversationBlocked:()=>false,
  conversationListPresence: (item: any) => ChatService.prototype.conversationListPresence.call(chat, item),
};
const previewSettings = signal({ chatListDensity: 'three-line' });
const previewCalls: any = {
  lastResult:signal(null),quickRepliesOpen:signal(false),quickReplyBusy:signal(false),
  quickReplies:[{id:'busy',text:'Estoy ocupado, te llamo más tarde.'},{id:'soon',text:'Ahora no puedo hablar. Te llamo en cuanto pueda.'},{id:'message',text:'No puedo atender. Escríbeme por aquí.'}],
  callPhoto:()=>previewAvatar,callInitials:()=> 'SM',
  decline:async()=>{ const call=previewCalls.activeCall();previewCalls.activeCall.set(null);previewCalls.phase.set('idle');previewCalls.lastResult.set({call,kind:'rejected',incoming:true,replied:true}); },
  activeCall: signal(null), resumableCall: signal(null), phase: signal('idle'),
  localStream: signal(null), remoteEntries: signal([]), activeScreenShareStreamId: signal(null),
  cameraOff: signal(false), remoteStates: signal({}), screenSharing: signal(false),
  mediaUpgradeRequested: signal(false), mediaUpgradeAwaitingPeer: signal(false), mediaUpgradeNotice: signal(''),
  mediaUpgradeInFlight: signal(false), muted: signal(false), speaker: signal(true), error: signal(''),
  screenShareNotice: signal(''), audioPlaybackBlocked: signal(false),
  isGroupCall: () => false, canEndGroupForEveryone: () => false, clearInactiveCallUi: () => {},
  canOfferScreenShare: () => false, canShareScreen: () => false, callStatusLabel: () => 'En llamada',
  callTitle: () => 'Sofía Martínez', end: async () => { previewCalls.activeCall.set(null); previewCalls.phase.set('idle'); },
  toggleMute: () => previewCalls.muted.update((value: boolean) => !value),
  toggleCamera: async () => previewCalls.cameraOff.update((value: boolean) => !value),
  games: { panelOpen: signal(false), invitationVisible: signal(false), state: signal(null) },
  audioOutput: { playbackBlocked: signal(false), routeError: signal(''), routeBusy:signal(false), availableRoutes: signal([]), selectedRouteId: signal('default'), selectedRouteLabel: () => 'Altavoz', toggleSpeakerRoute:async()=>false },
  dismissCallResult:()=>previewCalls.lastResult.set(null), messageLastCaller:async()=>{}, redialLast:async()=>{},
  history: signal(items().slice(0, 6).map((item, index) => ({ id: 'history-' + index, conversationId: item.id, initiatorUserId: index % 2 ? 'peer-1' : user.id, participantUserIds: ['peer-1', user.id], type: index % 2 ? 'Voice' : 'Video', status: index === 1 || index === 4 ? 'Missed' : 'Ended', startedAt: item.updatedAt, endedAt: item.updatedAt }))),
};
chat.participantDisplayName = (id: string) => id === user.id ? user.displayName : 'Sofía Martínez';
chat.participantPhoto = () => '';
@Component({ selector: 'preview-calls', standalone: true, imports: [CallsPage], template: '<app-calls />' })
class PreviewCalls {
  constructor() {
    const mode = new URLSearchParams(location.search).get('mode');
    if(mode === 'missed-voice' || mode === 'missed-video'){
      previewCalls.activeCall.set(null);previewCalls.phase.set('idle');
      previewCalls.lastResult.set({call:{id:'synthetic-missed',conversationId:'sofia',type:mode === 'missed-video'?'Video':'Voice',participantUserIds:[user.id,'peer-1'],initiatorUserId:user.id,startedAt:new Date().toISOString()},kind:'missed',incoming:false});
    }
    if (mode === 'voice' || mode === 'video') {
      previewCalls.activeCall.set({ id: 'synthetic-active', conversationId: 'sofia', type: mode === 'video' ? 'Video' : 'Voice', status: 'Active', initiatorUserId: user.id, participantUserIds: ['peer-1'], startedAt: new Date().toISOString() });
      previewCalls.phase.set('connected');
      previewCalls.remoteEntries.set([['peer-1', new MediaStream()]]);
      previewCalls.localStream.set(new MediaStream());
    }
  }
}
const stories=signal<any[]>([user,...items().map((item,i)=>({id:'peer-'+i,alias:item.id,displayName:item.name,profilePhotoDataUrl:previewAvatar}))].map((owner,i)=>({id:'story-'+i,owner,targetType:i===1?'group':'contacts',targetId:i===1?'design':null,visibility:'Contacts',encryptedPayload:'fixture',allowedUserIds:[],viewOnce:false,allowReposts:true,viewedByMe:i>5,viewCount:i+2,createdAt:new Date(Date.now()-i*600000).toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()})));
const request={id:'request-fixture',from:{id:'requester',alias:'daniela',displayName:'Daniela López'},to:user,status:'Pending',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
const social:any={contacts:signal(items().filter(item=>item.type==='Direct').map(item=>({userId:item.participants[1].userId,alias:item.id,displayName:item.name,isFavorite:item.id==='sofia',isMutualContact:true}))),
 contactsLoading:signal(false),requestsLoading:signal(false),incomingRequests:signal([request]),outgoingRequests:signal([]),requestHistory:signal([]),connectionsError:signal(''),people:signal([]),searching:signal(false),connectionActions:signal([]),radarMatches:signal([]),radarLoading:signal(false),loadConnections:async()=>{},search:async()=>[],loading:signal(false),publishing:signal(false),publishingStatus:signal(''),storyDeliveryWarning:signal(''),
 stories,worldStories:signal([]),activeStory:signal(null),storyViewerOwner:signal(null),load:async()=>{},
 activeStoriesForGroup:(id:string)=>stories().filter(story=>story.targetId===id),activeStoriesForOwner:(id:string)=>stories().filter(story=>story.owner.id===id&&!story.targetId),
 contactStories:()=>stories().filter(story=>!story.targetId),groupStories:()=>stories().filter(story=>!!story.targetId),isGroupStory:(story:any)=>!!story.targetId,
 storyText:()=> 'Un momento para compartir ✨',storyMedia:()=>null,storyMusic:()=>null,storyMediaError:()=>'',storyOpenError:signal(''),storyReadyId:signal('story-2'),storyOpening:signal(false),viewStory:async()=>{},ensureStoryMedia:async()=>null,
 isImage:(mime:string)=>mime.startsWith('image/'),isVideo:(mime:string)=>mime.startsWith('video/'),storyComments:()=>[],storyViews:()=>[],storyReactions:()=>[]};
@Component({selector:'preview-composer',standalone:true,imports:[StoryComposerComponent],template:'<app-story-composer [isOpen]="true" />'})
class PreviewComposer {}
@Component({selector:'preview-viewer',standalone:true,imports:[StoryViewerComponent],template:`<app-story-viewer [story]="story" [payload]="payload" [queue]="queue" [paused]="true" subtitle="Hace unos minutos" />`,styles:[':host{display:block;width:min(100%,520px);height:100%;margin:auto;background:#111}']})
class PreviewViewer {story=stories()[2];queue=stories().slice(1,5);payload={type:'text',text:'Los mejores momentos se comparten. ✨',textTheme:'rose'};}
@Component({selector:'preview-invitation',standalone:true,imports:[CallGameInvitationComponent,TransientNoticeDirective],template:`<section style="padding:100px 24px"><h1>Llamada en curso</h1><p [appTransientNotice]="notice" (noticeExpired)="notice=''" role="status">{{notice}}</p><app-call-game-invitation label="Sofía te invita a Puntos y cajas" /></section>`})
class PreviewInvitation {notice='Resultado de prueba temporal';}
// Visual fixture for the profile layout: actual account stylesheet, synthetic fields,
// no AccountService or authentication mutations.
@Component({ selector:'preview-profile', standalone:true, imports:[IonInput,IonTextarea,IonButton,IonIcon,IonContent],
  styleUrls:['../src/app/features/account/account.page.scss'],
  template:`<ion-content class="page"><main class="surface"><header class="page-head"><h1>Tu perfil</h1></header><section class="panel" style="max-width:700px;margin:auto">
    <div class="profile-hero profile-photo-row"><div class="profile-avatar-control"><button class="profile-photo" aria-label="Ver foto"><img [src]="avatar" alt=""></button><button class="photo-edit-badge" aria-label="Cambiar foto"><ion-icon name="camera-outline" /></button></div>
    <div class="profile-photo-actions"><div class="profile-hero-copy"><h2>Alex Martínez</h2><p>@alex</p><span class="profile-draft-tag">Perfil guardado</span></div><div class="profile-photo-buttons"><ion-button fill="outline">Cambiar foto</ion-button><ion-button fill="clear" color="danger">Quitar</ion-button></div><label class="profile-photo-visibility"><span><strong>Quién puede ver tu foto</strong><small>Tú eliges con quién compartirla.</small></span><select class="native-select" aria-label="Quién puede ver tu foto"><option>Mis contactos</option></select></label></div></div>
    <div class="form-grid profile-form"><label><span>Alias</span><ion-input value="alex" aria-label="Alias" /></label><label><span>Nombre</span><ion-input value="Alex Martínez" aria-label="Nombre" /></label><label class="wide"><span>Email</span><ion-input value="alex@example.test" readonly aria-label="Email" /></label><label class="wide"><span>Bio</span><ion-textarea rows="3" value="Los mejores momentos se comparten." aria-label="Bio" /></label></div>
  </section></main></ion-content>` })
class PreviewProfile { avatar=previewAvatar; }
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
@Component({selector:'preview-games',standalone:true,imports:[CallGamePanelComponent],
  template:`<app-call-game-panel [state]="state" currentUserId="alex" [participants]="participants" [transportReady]="true" (create)="create($event)" (action)="act($event)" (catalogue)="state=null" />`,
  styles:[':host{display:block;height:100%;overflow:auto;background:var(--nivra-panel-solid);}']})
class PreviewGames {
  state:CallGameState|null=null;
  participants=[{userId:'alex',label:'Alex'},{userId:'sofia',label:'Sofía'}];
  create(kind:CallGameKind):void {
    const initial=createCallGame(kind,'synthetic-game','alex');
    const joined=applyCallGameAction(initial,'sofia',{type:'join',gameId:initial.id,expectedRevision:initial.revision}).state;
    this.state=applyCallGameAction(joined,'alex',{type:'start',gameId:joined.id,expectedRevision:joined.revision}).state;
  }
  act(action:Parameters<typeof applyCallGameAction>[2]):void { if(this.state)this.state=applyCallGameAction(this.state,'alex',action).state; }
}
@Component({selector:'preview-incognito-dialog',standalone:true,imports:[IonModal,IonButton,IonIcon],template:`<button id="preview-open-incognito" (click)="open=true">Abrir confirmación</button><ion-modal mode="ios" class="nivra-incognito-modal" [isOpen]="open"><ng-template><section class="incognito-confirm"><ion-icon name="lock-closed-outline" /><h2>Chat incógnito</h2><p>Se abre un espacio cifrado con este contacto. Los mensajes viven en la sala y se limpian cuando cualquiera sale o se desconecta.</p><p>La otra persona puede conservar capturas. Revisa que ambos estén listos para entrar.</p><div><ion-button fill="clear">Cancelar</ion-button><ion-button>Abrir e invitar</ion-button></div></section></ng-template></ion-modal>`})
class PreviewIncognitoDialog { open=false; }
@Component({
  selector: 'app-root', standalone: true, imports: [RouterOutlet],
  template: `<router-outlet /><aside class="preview-controls"><span>Vista de prueba · Datos ficticios</span><button type="button" (click)="toggleDensity()">Cambiar líneas</button><button type="button" (click)="toggleTheme()">{{ light ? 'Tema oscuro' : 'Tema claro' }}</button></aside>`,
  styles: ['.preview-controls{position:fixed;right:20px;bottom:14px;z-index:100;display:flex;gap:12px;align-items:center;padding:8px 12px;background:var(--nivra-panel-solid);color:var(--nivra-muted);border:1px solid var(--nivra-line);border-radius:12px;font-size:11px}.preview-controls button{background:none;color:var(--nivra-brand-2);border:0;min-height:32px;cursor:pointer}@media(max-width:768px){.preview-controls{bottom:72px;font-size:9px;right:8px;padding:4px 8px}}'],
})
class PreviewRoot {
  light = new URLSearchParams(location.search).get('theme') === 'light';
  constructor() {
    this.applyTheme();
    const incoming=new URLSearchParams(location.search).get('incoming');
    if(incoming){previewCalls.activeCall.set({id:'synthetic-incoming',initiatorUserId:'peer-1',participantUserIds:[user.id,'peer-1'],type:incoming==='video'?'Video':'Voice',startedAt:new Date().toISOString()});previewCalls.phase.set('ringing');}
  }
  toggleTheme() { this.light = !this.light; this.applyTheme(); }
  toggleDensity() { previewSettings.update(value => ({ chatListDensity: value.chatListDensity === 'three-line' ? 'two-line' : 'three-line' })); }
  private applyTheme() { for (const root of [document.documentElement, document.body]) { root.classList.toggle('nivra-light-theme', this.light); root.classList.toggle('ion-palette-dark', !this.light); } }
}

@Component({selector:'preview-account-recovery',standalone:true,imports:[AccountIdentityRecoveryComponent],template:'<main style="padding:20px;max-width:600px;margin:auto"><app-account-identity-recovery /></main>'})
class PreviewAccountRecovery { constructor(){ (inject(AccountIdentityService).state as any).set('password'); } }

bootstrapApplication(PreviewRoot, { providers: [
  provideIonicAngular(), provideRouter([{ path: 'app', component: ShellPage, children: [
    { path: 'chats', component: ChatsPage, children: [{ path: ':id', component: PreviewConversation }] },
    { path: 'guide', component: GuidePage },
    { path: 'notification-check', component: NotificationCheckPage },
    { path: 'contacts', component: ContactsPage },
    { path: 'communities', component: CommunitiesPage },
    { path: 'vault', component: VaultPage },
    { path: 'calls', component: PreviewCalls },
    { path: 'games', component: PreviewGames },
    { path: 'world', component: WorldPage },{ path: 'composer', component: PreviewComposer },{ path: 'viewer', component: PreviewViewer },{ path: 'invitation', component: PreviewInvitation },
    { path: '**', component: PreviewEmpty },
  ] },{path:'preview/incognito-dialog',component:PreviewIncognitoDialog},{path:'preview/profile',component:PreviewProfile},{path:'preview/viewer',component:PreviewViewer},{path:'preview/calls',component:PreviewCalls},{path:'preview/recovery',component:PreviewAccountRecovery}, { path: '**', redirectTo: 'app/chats' }]),
  { provide: AuthService, useValue: { sessionGeneration:signal(1), session: signal({ user, device: { id: 'preview-device', isTrusted: true } }), savedAccounts: signal([]), accountsBusy: signal(false), addingAccount: signal(false), deviceIdentityError: signal(''), deviceIdentityNeedsRelink: signal(false), isAuthenticated: () => true, logout: async () => {} } },
  { provide: ChatService, useValue: chat },
  { provide: CommunityService, useValue: v9.communities },
  { provide: VaultService, useValue: v9.vault },
  { provide: DeviceWipeService, useValue: {} },
  { provide: PanicPinService, useValue: {} },
  { provide: SocialService, useValue: social },
  { provide: ContactSyncService,useValue:{syncCachedContactsInBackground:async()=>{},radarHasNewContact:()=>false,lastDeviceContactCount:()=>0,syncing:()=>false}},
  { provide: CallsService, useValue: previewCalls },
  { provide: AccountIdentityService, useValue: {state:signal('ready'),error:signal(''),phrase:async()=>''} },
  { provide: CallTranslationService, useValue: { enabled: signal(false), active: signal(false) } },
  { provide: SignalrService, useValue: { connected: signal(true) } },
  { provide: UnreadTabService, useValue: { unreadChats: signal(2) } },
  { provide: AppLockService, useValue: { isContentLocked: signal(false) } },
  { provide: PrivateChatLockService, useValue: { isProtected: () => false } },
  { provide: ClientCompatibilityService, useValue: { check: async () => {}, updateRequired: signal(false) } },
  { provide: NivraApiService, useValue: { baseUrl: '',post:()=>of({id:'synthetic-invite',code:'a'.repeat(43)}),get:()=>of([]) } },
  { provide: AppSettingsService, useValue: { settings: previewSettings } },
  { provide: LocalHistoryService, useValue: { storageError: signal(''), storageState: signal('ready'), storageBusy: signal(false) } },
  { provide: NativeDeviceService, useValue: {} },
  { provide: PushService, useValue: { permission: signal('default'), registering: signal(false), tokenId: signal(null), registeredOnServer: signal(false), serverReady: signal(true), error: signal(''), refreshStatus: async () => true, requestPermissionAndRegister: async () => false } },
  { provide: TranslateService, useValue: { instant: (_key: string, fallback: string) => fallback, currentLanguage: signal('es') } },
] }).catch(error => console.error(error));
