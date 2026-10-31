import { Routes } from '@angular/router';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './core/services/auth.service';
import { NativeOnboardingService } from './core/services/native-onboarding.service';

const authenticated = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return await auth.ensureSessionRestored() ? true : router.parseUrl('/auth');
};
export const guest = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const onboarding = inject(NativeOnboardingService);
  if (await auth.ensureSessionRestored()) return router.parseUrl('/app/chats');
  return onboarding.isPackagedApp() && !onboarding.isComplete() ? router.parseUrl('/welcome') : true;
};

export const welcomeGuest = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const onboarding = inject(NativeOnboardingService);
  if (await auth.ensureSessionRestored()) return router.parseUrl('/app/chats');
  return true;
};

export const landingGuest = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const onboarding = inject(NativeOnboardingService);
  if (await auth.ensureSessionRestored()) return router.parseUrl('/app/chats');
  if (onboarding.isPackagedApp()) {
    return router.parseUrl(onboarding.isComplete() ? '/auth' : '/welcome');
  }
  return true;
};

export const routes: Routes = [
  { path: 'group/invite', loadComponent: () => import('./features/chat-detail/group-invite.page').then(m => m.GroupInvitePage) },
  { path: 'recover', loadComponent: () => import('./features/auth/recovery.page').then(m => m.RecoveryPage) },
  {
    path: 'vault/invite',
    loadComponent: () => import('./features/vault-invite/vault-invite.page').then((m) => m.VaultInvitePage),
  },
  {
    path: 'contact',
    loadComponent: () => import('./features/contact-invite/contact-invite.page').then((m) => m.ContactInvitePage),
  },
  {
    path: 'welcome',
    canMatch: [welcomeGuest],
    loadComponent: () => import('./features/welcome/welcome.page').then((m) => m.WelcomePage),
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
      { path: 'identity/:userId', loadComponent: () => import('./features/chat-detail/identity-verification.page').then(m => m.IdentityVerificationPage) },
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
        path: 'broadcasts',
        loadComponent: () => import('./features/broadcasts/broadcasts.page').then(m => m.BroadcastsPage),
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
        path: 'share',
        loadComponent: () => import('./features/share-target/share-target.page').then((m) => m.ShareTargetPage),
      },
      {
        path: 'account',
        loadComponent: () => import('./features/account/account.page').then((m) => m.AccountPage),
      },
      { path: '', redirectTo: 'chats', pathMatch: 'full' },
    ],
  },
  {
    path: '',
    pathMatch: 'full',
    canMatch: [landingGuest],
    loadComponent: () => import('./features/landing/landing.page').then((m) => m.LandingPage),
  },
  { path: '**', redirectTo: 'app/chats' },
];
