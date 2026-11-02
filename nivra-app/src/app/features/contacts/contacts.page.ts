import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, ViewChild, effect, inject, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonButton, IonContent, IonIcon, IonInput, IonSpinner, IonTextarea } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { addOutline, arrowBackOutline, cameraOutline, chatbubbleEllipsesOutline, closeOutline, fingerPrintOutline, peopleOutline, personAddOutline, personRemoveOutline, phonePortraitOutline, qrCodeOutline, refreshOutline, scanOutline, searchOutline, shieldCheckmarkOutline, star, starOutline } from 'ionicons/icons';
import { Contact, UserSummary } from '../../core/models/nivra.models';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { ContactSyncService } from '../../core/services/contact-sync.service';
import { SocialService } from '../../core/services/social.service';
import { TranslateService } from '../../core/services/translate.service';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { rankConversationTitles } from '../chats/conversation-search';
import { identityDisplayName } from '../../core/utils/nivra-identity';
@Component({selector:'app-contacts',standalone:true,imports:[CommonModule,FormsModule,TranslatePipe,IonButton,IonContent,IonIcon,IonInput,IonSpinner,IonTextarea],templateUrl:'./contacts.page.html',styleUrls:['./contacts.page.scss']})
export class ContactsPage implements OnInit,OnDestroy {
 readonly social=inject(SocialService);readonly auth=inject(AuthService);readonly chat=inject(ChatService);
 readonly contactSync=inject(ContactSyncService);readonly translate=inject(TranslateService);private readonly router=inject(Router);
 @ViewChild('contactSearch') private input?:IonInput;
 query='';radarPhones='';busyId='';error='';notice='';searchOpen=false;radarOpen=false;
 private timer:number|null=null;private destroyed=false;private uiRevision=0;private searchRevision=0;
 private readonly runningActions=new Set<string>();private uiScope=this.accountScope();readonly personName=identityDisplayName;
 constructor(){
 addIcons({addOutline,arrowBackOutline,cameraOutline,chatbubbleEllipsesOutline,closeOutline,fingerPrintOutline,peopleOutline,personAddOutline,personRemoveOutline,phonePortraitOutline,qrCodeOutline,refreshOutline,scanOutline,searchOutline,shieldCheckmarkOutline,star,starOutline});
 effect(()=>{const scope=this.accountScope();untracked(()=>{if(scope===this.uiScope)return;this.uiScope=scope;++this.uiRevision;++this.searchRevision;
 if(this.timer!==null)window.clearTimeout(this.timer);this.timer=null;this.query='';this.radarPhones='';this.notice='';this.error='';this.busyId='';this.runningActions.clear();this.searchOpen=false;this.radarOpen=false;
 });});
 }
  async ngOnInit(): Promise<void> {
    await this.social.load();
    if (!this.destroyed) void this.contactSync.syncCachedContactsInBackground();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    ++this.uiRevision; ++this.searchRevision;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
  }

  searchChanged(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
    }
    const query = this.query;
    const scope = this.accountScope();
    const revision = ++this.searchRevision;
    // Invalidate an older in-flight query immediately, including when clearing input.
    void this.social.search('');
    if (query.trim().length < 2) return;
    this.timer = window.setTimeout(() => {
      void this.social.search(query).catch(error => {
        if (!this.destroyed && scope === this.accountScope() && revision === this.searchRevision) this.error = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la acción.');
      });
    }, 300);
  }

  async request(person: UserSummary): Promise<void> {
    await this.run(person.id, async current => {
      await this.social.requestFriend(person);
      if (current()) this.notice = this.social.incomingRequests().some(request => request.from.id === person.id)
        ? this.tr('WORLD.NOTICE_REQUEST_RECEIVED', 'Esta persona ya te ha enviado una solicitud. Revísala en Recibidas.')
        : this.tr('WORLD.NOTICE_REQUEST_SENT', 'Solicitud enviada.');
    });
  }

  async addContact(person: UserSummary): Promise<void> {
    await this.run(`contact:${person.id}`, async current => {
      await this.social.addContact(person);
      if (current()) this.notice = this.tr('WORLD.NOTICE_CONTACT_SAVED', 'Contacto guardado.');
    });
  }

  async scanRadar(): Promise<void> {
    await this.run('radar', async current => {
      const response = await this.social.scanPhoneRadar(this.radarPhones);
      if (!current()) return;
      if (response.matched) {
        this.notice = this.social.radarNewCount()
          ? `${this.social.radarNewCount()} contacto nuevo en Nivra.`
          : `${response.matched} contacto${response.matched === 1 ? '' : 's'} detectado${response.matched === 1 ? '' : 's'}.`;
      } else {
        this.notice = response.submitted ? this.tr('WORLD.NO_MATCHES_NOW', 'Sin coincidencias por ahora.') : this.tr('WORLD.ADD_PHONES_SCAN', 'Agrega telefonos para escanear.');
      }
      this.contactSync.clearContactJoinedHint();
    });
  }

  async pickDeviceContacts(): Promise<void> {
    await this.run('radar:picker', async current => {
      const phones = await this.contactSync.pickAndSyncDeviceContacts();
      if (!current()) return;
      this.radarPhones = phones.join('\n');
      await this.scanRadar();
      if (!current()) return;
      if (!this.social.radarMatches().length && this.contactSync.lastDeviceContactCount()) {
        this.notice = `${this.contactSync.lastDeviceContactCount()} ${this.tr('WORLD.CONTACTS_SYNCED_HINT', 'telefonos sincronizados. Si alguno visible usa Nivra, aparecera aqui.')}`;
      }
    });
  }

  async openPerson(person: UserSummary): Promise<void> {
    await this.run(`open:${person.id}`, async current => {
      const conversation = await this.chat.createDirectConversation(person);
      if (!current()) return;
      await this.router.navigateByUrl(`/app/chats/${conversation.id}`);
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
    await this.run(`remove:${contact.userId}`, async current => {
      await this.social.deleteContact(contact);
      if (current()) this.notice = this.tr('WORLD.NOTICE_CONTACT_DELETED', 'Contacto eliminado.');
    });
  }

  isGhostMode(): boolean {
    const user = this.auth.session()?.user;
    return user?.isDiscoverable === false;
  }

  radarCountLabel(): string {
    const count = this.social.radarMatches().length;
    return `${count} coincidencia${count === 1 ? '' : 's'}`;
  }

  radarStateIcon(): string {
    if (this.contactSync.syncing()) {
      return 'refresh-outline';
    }
    return this.isGhostMode() ? 'finger-print-outline' : 'shield-checkmark-outline';
  }

  radarStateLabel(): string {
    if (this.contactSync.syncing()) {
      return this.tr('WORLD.SYNCING_AGENDA', 'Sincronizando agenda');
    }
    const contactCount = this.contactSync.lastDeviceContactCount();
    if (contactCount > 0) {
      return `${contactCount} ${this.tr('WORLD.PHONES_READY', 'telefonos listos')}`;
    }
    return this.isGhostMode() ? this.tr('WORLD.INVISIBLE_AGENDAS', 'Invisible para agendas') : this.tr('WORLD.AVAILABLE_MATCHES', 'Disponible para coincidencias');
  }

  async openAccount(): Promise<void> {
    await this.router.navigateByUrl('/app/account');
  }

  contactAsPerson(contact: Contact): UserSummary {
    return {
      id: contact.userId,
      nivraNumber: contact.nivraNumber,
      alias: contact.alias,
      displayName: contact.displayName,
      profilePhotoDataUrl: contact.profilePhotoDataUrl,
      bio: null,
      isDiscoverable: true,
      allowStoryReposts: true,
      isContact: true,
      isMutualContact: contact.isMutualContact,
      isFavorite: contact.isFavorite,
      friendshipState: contact.isMutualContact ? 'friends' : 'none',
    };
  }

  private async run(id: string, action: (current: () => boolean) => Promise<void>): Promise<void> {
    if (this.destroyed || this.runningActions.has(id)) return;
    const scope = this.accountScope();
    const revision = this.uiRevision;
    const current = () => !this.destroyed && this.uiRevision === revision && this.accountScope() === scope;
    this.runningActions.add(id);
    this.busyId = id;
    this.error = '';
    this.notice = '';
    try {
      await action(current);
    } catch (error) {
      if (!current()) return;
      this.error = error instanceof Error ? error.message : this.tr('COMMON.ACTION_ERROR', 'No se pudo completar la accion.');

    } finally {
      if (current()) {
        this.runningActions.delete(id);
        this.busyId = [...this.runningActions].pop() ?? '';
      }
    }
  }

  isBusy(id: string): boolean { return this.runningActions.has(id); }
  personBusy(personId: string): boolean { return this.social.connectionActions().includes(`person:${personId}`); }
  friendshipLabel(person: UserSummary): string {
    const state = person.friendshipState?.toLowerCase();
    return state === 'friends' || person.isMutualContact ? this.tr('WORLD.FRIENDS', 'Contactos mutuos') : state === 'incoming' ? this.tr('WORLD.REQUEST_RECEIVED', 'Solicitud recibida') : state === 'requested' ? this.tr('WORLD.REQUEST_SENT', 'Solicitud enviada') : person.isContact ? this.tr('WORLD.CONTACT_SAVED', 'Contacto guardado') : this.tr('WORLD.NO_REQUEST', 'Sin solicitud');
  }
  private accountScope(): string {
    const session = this.auth.session(); return session ? `${session.user.id}:${session.device.id}` : '';
  }

  private tr(key: string, fallback: string): string {
    return this.translate.instant(key, fallback);
  }


  filteredContacts(): Contact[] {
    const contacts = [...this.social.contacts()].sort((a,b) => Number(b.isFavorite)-Number(a.isFavorite) || this.personName(a).localeCompare(this.personName(b)));
    return this.query.trim() ? rankConversationTitles(contacts, this.query, contact => [this.personName(contact), contact.alias, contact.nivraNumber || ''].join(' ')) : contacts;
  }
 focusSearch():void{this.searchOpen=true;requestAnimationFrame(()=>void this.input?.setFocus());}
 closeSearch():void{this.query='';this.searchOpen=false;this.searchChanged();void this.input?.getInputElement().then(input=>input.blur());}
 back():void{void this.router.navigateByUrl('/app/chats');}
 compose(kind:'group'|'story'|'pass'):void{void this.router.navigate(['/app/chats'],{queryParams:{compose:kind}});}
 reviewRequests():void{void this.router.navigateByUrl('/app/world#friend-requests');}
 async openSelf():Promise<void>{const user=this.auth.session()?.user;if(user)await this.openPerson({...user,isContact:false,isMutualContact:false,isFavorite:false,friendshipState:'none'} as UserSummary);}
}
