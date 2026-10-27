import { Component, EventEmitter, Output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { chatbubbleEllipsesOutline, createOutline, lockClosedOutline, phonePortraitOutline, shieldCheckmarkOutline, sunnyOutline } from 'ionicons/icons';
import { TranslatePipe } from '../../core/pipes/translate.pipe';

export const ACCOUNT_SECTION_LINKS = [
  { id: 'account-profile', icon: 'create-outline', labelKey: 'ACCOUNT.PROFILE', label: 'Perfil' },
  { id: 'account-appearance', icon: 'sunny-outline', labelKey: 'ACCOUNT.APPEARANCE', label: 'Apariencia' },
  { id: 'account-chats', icon: 'chatbubble-ellipses-outline', labelKey: 'TABS.CHATS', label: 'Chats' },
  { id: 'account-lock', icon: 'lock-closed-outline', labelKey: 'ACCOUNT.SAFE_MODE', label: 'Modo Seguro' },
  { id: 'account-privacy', icon: 'shield-checkmark-outline', labelKey: 'ACCOUNT.PRIVACY', label: 'Privacidad' },
  { id: 'account-devices', icon: 'phone-portrait-outline', labelKey: 'ACCOUNT.DEVICES', label: 'Dispositivos' },
] as const;
export type AccountSectionId = typeof ACCOUNT_SECTION_LINKS[number]['id'];

@Component({
  selector: 'app-account-navigation', standalone: true, imports: [IonIcon, TranslatePipe],
  template: `<nav [attr.aria-label]="'ACCOUNT.SECTIONS' | translate:'Secciones de cuenta'">
    @for (section of sections; track section.id) {
      <button type="button" [attr.aria-controls]="section.id" (click)="openSection.emit(section.id)">
        <ion-icon [name]="section.icon" aria-hidden="true" />
        <span>{{ section.labelKey | translate:section.label }}</span>
      </button>
    }
  </nav>`,
  styles: [`:host{display:block;max-width:1040px;margin:0 auto 20px;container-type:inline-size}
    nav{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:8px}
    button{display:flex;align-items:center;justify-content:center;gap:9px;min-width:0;min-height:52px;padding:10px;border:1px solid var(--nivra-line);border-radius:15px;background:var(--nivra-panel-solid);color:var(--nivra-text);font:inherit;font-weight:600;font-size:13px;line-height:1.3;cursor:pointer;transition:border-color .16s,background .16s}
    button:hover{border-color:var(--nivra-brand-2);background:color-mix(in srgb,var(--nivra-brand) 6%,var(--nivra-panel-solid))}
    button:focus-visible{outline:3px solid var(--nivra-brand);outline-offset:2px}
    ion-icon{flex:0 0 20px;color:var(--nivra-brand-2);font-size:20px}
    span{overflow-wrap:anywhere}
    @media(max-width:680px){nav{grid-template-columns:repeat(3,minmax(0,1fr))}button{flex-direction:column;gap:6px;min-height:68px;padding:10px 6px;font-size:12px}}
    @container(max-width:680px){nav{grid-template-columns:repeat(3,minmax(0,1fr))}button{flex-direction:column;gap:6px;min-height:68px;padding:10px 6px;font-size:12px}}
    @media(prefers-reduced-motion:reduce){button{transition:none}}`],
})
export class AccountNavigationComponent {
  readonly sections = ACCOUNT_SECTION_LINKS;
  @Output() openSection = new EventEmitter<AccountSectionId>();
  constructor() { addIcons({ chatbubbleEllipsesOutline, createOutline, lockClosedOutline, phonePortraitOutline, shieldCheckmarkOutline, sunnyOutline }); }
}
