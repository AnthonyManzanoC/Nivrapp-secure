import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { provideIonicAngular } from '@ionic/angular/standalone';
import { AuthService } from '../../core/services/auth.service';
import { AppLockService } from '../../core/services/app-lock.service';
import { CryptoService } from '../../core/services/crypto.service';
import { IdentityTrustService } from '../../core/services/identity-trust.service';
import { NivraApiService } from '../../core/services/nivra-api.service';
import { TranslateService } from '../../core/services/translate.service';
import { IdentityVerificationPage } from './identity-verification.page';

describe('Contact security presentation', () => {
  it('keeps comparison optional on first use and reveals it when keys need attention', async () => {
    TestBed.configureTestingModule({ imports: [IdentityVerificationPage], providers: [
      provideIonicAngular({ mode: 'ios' }), provideRouter([]),
      { provide: AuthService, useValue: { session: signal({ user: { id: 'owner' }, device: { id: 'phone' } }) } },
      { provide: AppLockService, useValue: { isLocked: signal(false) } },
      { provide: CryptoService, useValue: {} }, { provide: IdentityTrustService, useValue: {} },
      { provide: NivraApiService, useValue: {} },
      { provide: Location, useValue: { getState: () => ({}) } },
      { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'peer' } } } },
      { provide: TranslateService, useValue: { currentLanguage: signal('es'), instant: (_key: string, fallback: string) => fallback } },
    ] });
    const init = TestBed.inject(ApplicationInitStatus) as unknown as { runInitializers(): void; donePromise: Promise<void> };
    init.runInitializers(); await init.donePromise;
    const fixture = TestBed.createComponent(IdentityVerificationPage), page = fixture.componentInstance;
    spyOn(page, 'loadIdentity').and.resolveTo();
    page.loading = false; page.code = 'abcd '.repeat(16).trim(); page.contactAlias = 'lucia';
    page.qr = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="white"/><path d="M20 20h70v70H20zm146 0h70v70h-70zM20 166h70v70H20zM120 120h116v116H120z" fill="black"/></svg>');
    page.continuity = 'unknown'; fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('.identity-qr')).toBeNull();
    const toggle = root.querySelector<HTMLButtonElement>('.comparison-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click(); fixture.detectChanges();
    expect(root.querySelector('.identity-qr')).not.toBeNull();
    expect(page.verified).toBeFalse();
    page.continuity = 'changed'; page.comparisonExpanded = true; fixture.detectChanges();
    expect(root.querySelector('.continuity-card.changed')).not.toBeNull();
    expect(root.querySelector('.recheck-action')).not.toBeNull();
    expect(root.querySelector('.identity-qr')).not.toBeNull();
    if ((window as any).__karma__?.config?.args?.includes('visual-identity')) {
      document.body.append(root); root.style.cssText = 'display:block;height:100vh';
      (window as any).__identityVisual = (state: 'unknown' | 'unchanged' | 'verified' | 'changed') => {
        page.continuity = state; page.verified = state === 'verified'; page.comparisonExpanded = state === 'changed';
        page.checkedAt = '2026-10-30T18:00:00Z'; fixture.detectChanges(); root.scrollTop = 0;
      };
      await new Promise<void>(resolve => (window as any).__identityVisualDone = resolve);
      root.remove();
    }
    fixture.destroy();
  }, 180000);
});
