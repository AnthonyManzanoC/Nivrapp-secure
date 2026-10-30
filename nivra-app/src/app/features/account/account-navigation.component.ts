import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chatbubbleEllipsesOutline, createOutline, lockClosedOutline, phonePortraitOutline, shieldCheckmarkOutline, sunnyOutline, searchOutline, closeOutline, chevronForwardOutline, eyeOffOutline, languageOutline, shareSocialOutline, sparklesOutline, notificationsOutline, folderOpenOutline, optionsOutline, helpCircleOutline, qrCodeOutline, warningOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
import { TranslateService } from '../../core/services/translate.service';

export const ACCOUNT_SECTION_LINKS = [
  { id: 'account-profile', icon: 'create-outline', labelKey: 'ACCOUNT.PROFILE', label: 'Perfil' },
  { id: 'account-appearance', icon: 'sunny-outline', labelKey: 'ACCOUNT.APPEARANCE', label: 'Apariencia' },
  { id: 'account-chats', icon: 'chatbubble-ellipses-outline', labelKey: 'TABS.CHATS', label: 'Chats' },
  { id: 'account-lock', icon: 'lock-closed-outline', labelKey: 'ACCOUNT.SAFE_MODE', label: 'Modo Seguro' },
  { id: 'account-privacy', icon: 'shield-checkmark-outline', labelKey: 'ACCOUNT.PRIVACY', label: 'Privacidad' },
  { id: 'account-devices', icon: 'phone-portrait-outline', labelKey: 'ACCOUNT.DEVICES', label: 'Dispositivos' },
] as const;
export const ACCOUNT_SEARCH_SECTIONS = [
  ...ACCOUNT_SECTION_LINKS.map((section, index) => ({ ...section, keywords: [
    'nombre alias foto avatar contraseña recuperar name photo password recovery',
    'tema oscuro claro icono launcher color tamaño theme dark light icon font size',
    'mensajes fondo enter stickers mensajes temporales messages wallpaper',
    'pin huella rostro bloqueo seguridad fingerprint face lock security',
    'lectura capturas reenviar panico read receipts screenshot forwarding panic',
    'sesiones equipos vinculados sessions linked devices',
  ][index] })),
  { id: 'account-identity', icon: 'eye-off-outline', labelKey: 'ACCOUNT.IDENTITY_GHOST', label: 'Fantasma', keywords: 'identidad publico visibilidad buscar identity public visibility discovery ghost' },
  { id: 'account-language', icon: 'language-outline', labelKey: 'settings.language.title', label: 'Idioma', keywords: 'traducir traduccion language translate translation' },
  { id: 'account-share', icon: 'share-social-outline', labelKey: 'ACCOUNT.SHARE_NIVRA', label: 'Compartir Nivra', keywords: 'invitar pase share invite pass' },
  { id: 'account-plan', icon: 'sparkles-outline', labelKey: 'ACCOUNT.PLAN', label: 'Plan', keywords: 'limites suscripcion premium limits subscription' },
  { id: 'account-notifications', icon: 'notifications-outline', labelKey: 'ACCOUNT.NOTIFICATIONS', label: 'Notificaciones', keywords: 'avisos alertas sonido push llamadas notifications sound calls alerts' },
  { id: 'account-storage', icon: 'folder-open-outline', labelKey: 'settings.data.title', label: 'Datos y almacenamiento', keywords: 'galeria archivos espacio borradores data storage gallery files drafts' },
  { id: 'account-behavior', icon: 'options-outline', labelKey: 'settings.behavior.title', label: 'Otros ajustes', keywords: 'levantar escuchar hablar pausar musica audio raise listen speak pause music behavior' },
  { id: 'account-help', icon: 'help-circle-outline', labelKey: 'settings.diagnostics.title', label: 'Ayuda y depuración', keywords: 'diagnostico registros restaurar help diagnostics logs restore' },
  { id: 'account-link', icon: 'qr-code-outline', labelKey: 'ACCOUNT.LINK_QR', label: 'Vincular por QR', keywords: 'autorizar camara escanear link authorize scan camera qr' },
  { id: 'account-danger', icon: 'warning-outline', labelKey: 'ACCOUNT.DANGER_ZONE', label: 'Zona sensible', keywords: 'borrar eliminar desactivar cuenta delete deactivate account' },
] as const;
export type AccountSectionId = typeof ACCOUNT_SEARCH_SECTIONS[number]['id'];

@Component({
  selector: 'app-account-navigation', standalone: true, imports: [IonIcon, TranslatePipe],
  templateUrl: './account-navigation.component.html',
  styleUrl: './account-navigation.component.scss',
})
export class AccountNavigationComponent {
  private readonly translate = inject(TranslateService);
  readonly sections = ACCOUNT_SECTION_LINKS;
  readonly query = signal('');
  readonly searching = computed(() => !!this.query().trim());
  readonly results = computed(() => {
    const terms = this.normalize(this.query()).split(/\s+/).filter(Boolean);
    return ACCOUNT_SEARCH_SECTIONS.filter(section => {
      const searchable = this.normalize(`${this.translate.instant(section.labelKey, section.label)} ${section.label} ${section.keywords}`);
      return terms.every(term => searchable.includes(term));
    });
  });
  @Output() openSection = new EventEmitter<AccountSectionId>();
  constructor() { addIcons({ chatbubbleEllipsesOutline, createOutline, lockClosedOutline, phonePortraitOutline, shieldCheckmarkOutline, sunnyOutline, searchOutline, closeOutline, chevronForwardOutline, eyeOffOutline, languageOutline, shareSocialOutline, sparklesOutline, notificationsOutline, folderOpenOutline, optionsOutline, helpCircleOutline, qrCodeOutline, warningOutline }); }
  openFirst(event: Event): void {
    event.preventDefault();
    if (this.searching() && this.results().length) this.openSection.emit(this.results()[0].id);
  }
  private normalize(value: string): string {
    return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
  }
}
