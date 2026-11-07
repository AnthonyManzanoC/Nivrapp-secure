import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonContent } from '@ionic/angular/standalone';
import { NotificationCheckComponent } from './notification-check.component';
import { TranslatePipe } from '../../core/pipes/translate.pipe';
@Component({ standalone: true, imports: [IonContent, RouterLink, NotificationCheckComponent, TranslatePipe],
  template: `<ion-content><main><a routerLink="/app/account">← {{ 'TABS.ACCOUNT' | translate:'Cuenta' }}</a><app-notification-check /></main></ion-content>`,
  styles: [`:host{display:block;height:100%}ion-content{--background:var(--nivra-bg)}main{max-width:820px;margin:auto;padding:24px 18px calc(36px + env(safe-area-inset-bottom))}a{color:var(--nivra-brand-2);display:inline-block;padding:12px 0 24px}`] })
export class NotificationCheckPage {}
