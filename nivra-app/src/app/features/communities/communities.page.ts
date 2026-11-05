import { Component, DestroyRef, ElementRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { takeUntilDestroyed, toObservable, toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of, startWith, switchMap } from 'rxjs';
import { Community, CommunityJoinRequest, CommunityService } from '../../core/services/community.service';
import { AuthService } from '../../core/services/auth.service';
import { ChatService } from '../../core/services/chat.service';
import { TransientNoticeDirective } from '../../shared/transient-notice.directive';
import { GroupInviteShareComponent } from '../chat-detail/group-invite-share.component';
import { Participant } from '../../core/models/nivra.models';

@Component({selector:'app-communities',standalone:true,imports:[FormsModule,RouterLink,IonContent,TransientNoticeDirective,GroupInviteShareComponent],
  templateUrl:'./communities.page.html',styleUrls:['./communities.page.scss']})
export class CommunitiesPage {
  readonly communities=inject(CommunityService);
  readonly chat=inject(ChatService);
  private readonly auth=inject(AuthService);
  private readonly route=inject(ActivatedRoute);
  private readonly router=inject(Router);
  private readonly destroyRef=inject(DestroyRef);
  private readonly content = viewChild(IonContent);
  private readonly groupManager = viewChild<ElementRef<HTMLElement>>('groupManager');
  readonly selectedId=signal('');
  readonly creating=signal(false);
  readonly fromChats = signal(false);
  readonly infoOpen = signal(false);
  readonly invitationOpen = signal(false);
  readonly announcementConversation = computed(() => this.chat.conversations().find(item => item.id === this.selectedId()) ?? null);
  memberQuery = '';
  memberBusy = '';
  members(): Participant[] {
    const query = this.memberQuery.trim().toLocaleLowerCase();
    return (this.announcementConversation()?.participants ?? []).filter(member => !member.removedAt && (!query || `${member.displayName ?? ''} ${member.alias ?? ''}`.toLocaleLowerCase().includes(query)))
      .sort((a,b) => Number(['Owner','Admin'].includes(b.role))-Number(['Owner','Admin'].includes(a.role)) || (a.displayName || a.alias || '').localeCompare(b.displayName || b.alias || ''));
  }
  memberName(member: Participant): string { return this.chat.participantDisplayName(member.userId,member); }
  memberPhoto(member: Participant): string { return this.chat.participantPhoto(member.userId,member); }
  editing=false;
  private uiScope=this.scope();
  readonly selected=computed(()=>this.communities.items().find(item=>item.id===this.selectedId())??null);
  private readonly reviewTarget = computed(() => {
    const item = this.selected();
    return item?.groups.some(group => group.canReview) ? { id: item.id, scope: this.scope() } : null;
  });
  private readonly reviewLoad = toSignal(toObservable(this.reviewTarget).pipe(switchMap(target => {
    if (!target) return of(null);
    const initial = { ...target, requests: [] as CommunityJoinRequest[], error: false, loading: true };
    return this.communities.joinRequests(target.id).pipe(
      map(requests => ({ ...initial, requests, loading: false })),
      catchError(() => of({ ...initial, error: true, loading: false })),
      startWith(initial),
    );
  })), { initialValue: null });
  readonly reviewQueue = computed(() => {
    const load = this.reviewLoad();
    return load?.id === this.selectedId() && load.scope === this.scope() && this.reviewTarget() ? load : null;
  });
  readonly groupSections = computed(() => {
    const groups = this.selected()?.groups ?? [];
    return [
      { id: 'joined', title: 'Grupos a los que perteneces', groups: groups.filter(group => group.joined) },
      { id: 'available', title: 'Grupos a los que puedes solicitar acceso', groups: groups.filter(group => !group.joined) },
    ].filter(section => section.groups.length > 0);
  });
  readonly availableGroups=computed(()=>{
    const linked=new Set(this.communities.items().flatMap(c=>[c.id,...c.groups.map(g=>g.id)]));
    return this.chat.conversations().filter(c=>this.chat.isGroup(c)&&!linked.has(c.id)&&c.participants.some(p=>p.userId===this.auth.session()?.user.id&&!p.removedAt&&['Owner','Admin'].includes(p.role)));
  });
  name='';description='';photo:string|null=null;groupIds=new Set<string>();linkId='';newGroupName='';
  notice='';formError='';shareUrl='';query='';
  constructor(){this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe(params=>{
    this.fromChats.set(params.get('from') === 'chats');
    this.infoOpen.set(params.get('info') === '1');
    this.invitationOpen.set(false); this.memberQuery = ''; this.memberBusy = '';
    this.creating.set(params.get('create')==='1');this.selectedId.set(params.get('id')??'');this.shareUrl='';this.editing=false;
    this.linkId = '';
    this.newGroupName = '';
    this.formError = '';
    void this.content()?.scrollToTop(0);
  });
    effect(()=>{const scope=this.scope();untracked(()=>{if(scope===this.uiScope)return;this.uiScope=scope;
      this.selectedId.set('');this.creating.set(false);this.infoOpen.set(false);this.invitationOpen.set(false);this.memberQuery='';this.memberBusy='';this.editing=false;this.name='';this.description='';this.photo=null;
      this.groupIds=new Set();this.linkId='';this.newGroupName='';this.notice='';this.formError='';this.shareUrl='';this.query='';
    });});
  }
  private scope():string{return JSON.stringify([this.auth.session()?.user.id,this.auth.session()?.device.id,this.auth.sessionGeneration?.()??0]);}
  isAdmin(item:Community):boolean{return ['Owner','Admin'].includes(item.role);}
  groupName(id: string): string { return this.selected()?.groups.find(group => group.id === id)?.name ?? 'Grupo'; }
  filtered():Community[]{const q=this.query.trim().toLocaleLowerCase();return this.communities.items().filter(c=>c.name.toLocaleLowerCase().includes(q));}
  select(item:Community):void{this.navigate({id:item.id});}
  newCommunity():void{this.navigate({create:1});}
  back():void{this.navigate(this.infoOpen() ? {id:this.selectedId()} : {});}
  openInfo(): void { this.navigate({id:this.selectedId(),info:1}); void this.chat.refreshChats().then(() => this.chat.hydrateConversationProfile(this.announcementConversation())).catch(() => undefined); }
  chatContext(): {community: string; communityFrom?: string} { return this.fromChats() ? {community:this.selectedId(),communityFrom:'chats'} : {community:this.selectedId()}; }
  async toggleAdmin(member: Participant): Promise<void> {
    const conversation=this.announcementConversation(),item=this.selected(),scope=this.scope();
    if(!conversation||!item||!this.isAdmin(item)||member.role==='Owner'||this.memberBusy)return;
    this.memberBusy=member.userId;
    try { await this.chat.setGroupParticipantAdmin(conversation,member.userId,member.role!=='Admin'); if(scope===this.scope()&&!this.destroyRef.destroyed){this.notice='Permisos actualizados.';void this.communities.load(true);} }
    catch { if(scope===this.scope()&&!this.destroyRef.destroyed)this.notice='No se pudieron actualizar los permisos. Revisa tu conexión.'; }
    finally { if(scope===this.scope()&&!this.destroyRef.destroyed)this.memberBusy=''; }
  }
  private navigate(queryParams: { id?: string; create?: number; info?: number }): void {
    void this.router.navigate(['/app/communities'], {
      queryParams: this.fromChats() ? { ...queryParams, from: 'chats' } : queryParams,
    });
  }
  showGroupManager(): void {
    const heading = this.groupManager()?.nativeElement;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
  cancelEditor(): void {
    if (this.communities.busy()) return;
    if (this.infoOpen()) { this.back(); return; }
    if (!this.editing) {
      this.back();
      return;
    }
    this.editing = false;
    this.formError = '';
    void this.content()?.scrollToTop(0);
  }
  toggleGroup(id:string):void{const next=new Set(this.groupIds);next.has(id)?next.delete(id):next.add(id);this.groupIds=next;}
  async pickPhoto(event:Event):Promise<void>{
    const input=event.target as HTMLInputElement,file=input.files?.[0];input.value='';if(!file)return;
    if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>256000){this.formError='Elige una foto PNG, JPEG o WebP de hasta 256 KB.';return;}
    const scope=this.scope();
    const result=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('No se pudo abrir la foto.'));reader.readAsDataURL(file);}).catch(()=>null);
    if(!this.destroyRef.destroyed&&scope===this.scope()){if(result)this.photo=result;else this.formError='No se pudo abrir la foto.';}
  }
  async create():Promise<void>{
    if(!this.name.trim()||this.communities.busy())return;
    if(this.editing){const item=this.selected();if(!item)return;
      const result=await this.communities.update(item.id,{name:this.name.trim(),description:this.description.trim(),photo:this.photo});
      if(result&&!this.destroyRef.destroyed){this.editing=false;this.notice='Comunidad actualizada.';}return;
    }
    const result=await this.communities.create({name:this.name.trim(),description:this.description.trim(),photo:this.photo,groupIds:[...this.groupIds]});
    if(result&&!this.destroyRef.destroyed){this.name='';this.description='';this.photo=null;this.groupIds=new Set();this.notice='Tu comunidad está lista.';this.select(result);}
  }
  edit(item:Community):void{this.name=item.name;this.description=item.description;this.photo=item.photo;this.editing=true;this.shareUrl='';void this.content()?.scrollToTop(0);}
  async leave():Promise<void>{const item=this.selected();if(!item||!window.confirm('¿Salir de esta comunidad y de sus grupos? Los mensajes guardados se conservan. Si administras un grupo, otro miembro continuará como administrador.'))return;
    if(await this.communities.leave(item.id)){this.notice='Saliste de la comunidad.';this.back();}
  }
  async link():Promise<void>{const item=this.selected();if(!item||!this.linkId)return;const result=await this.communities.link(item.id,this.linkId);if(result){this.linkId='';this.notice='Grupo vinculado.';}}
  async createGroup():Promise<void>{const item=this.selected();if(!item||!this.newGroupName.trim())return;const result=await this.communities.createGroup(item.id,this.newGroupName.trim(),[]);if(result){this.newGroupName='';this.notice='Grupo creado. Los miembros de la comunidad pueden unirse.';}}
  async join(groupId: string): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    const result = await this.communities.requestJoin(id, groupId);
    if (!result || this.destroyRef.destroyed || this.selectedId() !== id) return;
    if (result.conversationId) await this.router.navigate(['/app/chats', result.conversationId], {queryParams:this.chatContext()});
    else if (result.pending) this.notice = 'Solicitud enviada. Un administrador del grupo puede aprobarla.';
  }
  async review(request: CommunityJoinRequest, accept: boolean): Promise<void> {
    const id = this.selectedId();
    if (!id) return;
    if (await this.communities.reviewJoinRequest(id, request, accept) && !this.destroyRef.destroyed && this.selectedId() === id) {
      this.notice = accept ? 'Solicitud aprobada.' : 'Solicitud rechazada.';
    }
  }
  invite():void{this.invitationOpen.update(open=>!open);}
  async unlink(groupId:string):Promise<void>{const item=this.selected();if(!item)return;await this.communities.unlink(item.id,groupId);if(!this.communities.error())this.notice='Se desvinculó el grupo. Sus conversaciones se conservan.';}
}
