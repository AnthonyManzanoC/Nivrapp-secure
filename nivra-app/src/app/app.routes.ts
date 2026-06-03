import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './core/services/auth.service';

const authenticated = () => inject(AuthService).isAuthenticated() ? true : inject(Router).parseUrl('/auth');
const guest = () => inject(AuthService).isAuthenticated() ? inject(Router).parseUrl('/app/chats') : true;

export const routes: Routes = [
  {
    path: 'vault/invite',
    loadComponent: () => import('./features/vault-invite/vault-invite.page').then((m) => m.VaultInvitePage),
  },
  {
    path: 'contact',
    loadComponent: () => import('./features/contact-invite/contact-invite.page').then((m) => m.ContactInvitePage),
  },
  {
    path: 'auth',
    canMatch: [guest],
    loadComponent: () => import('./features/auth/auth.page').then((m) => m.AuthPage),
  },
  {
    path: 'app',
    canMatch: [authenticated],
    loadComponent: () => import('./features/shell/shell.page').then((m) => m.ShellPage),
    children: [
      {
        path: 'chats',
        loadComponent: () => import('./features/chats/chats.page').then((m) => m.ChatsPage),
        children: [
          {
            path: ':conversationId',
            loadComponent: () => import('./features/chat-detail/chat-detail.page').then((m) => m.ChatDetailPage),
          },
        ],
      },
      {
        path: 'world',
        loadComponent: () => import('./features/world/world.page').then((m) => m.WorldPage),
      },
      {
        path: 'vault',
        loadComponent: () => import('./features/vault/vault.page').then((m) => m.VaultPage),
      },
      {
        path: 'calls',
        loadComponent: () => import('./features/calls/calls.page').then((m) => m.CallsPage),
      },
      {
        path: 'account',
        loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage),
      },
      { path: '', redirectTo: 'chats', pathMatch: 'full' },
    ],
  },
  { path: '', redirectTo: 'app/chats', pathMatch: 'full' },
  { path: '**', redirectTo: 'app/chats' },
];
