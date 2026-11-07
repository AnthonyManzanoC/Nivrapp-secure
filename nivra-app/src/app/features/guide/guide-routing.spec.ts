import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlSegment, provideRouter } from '@angular/router';
import { firstSteps } from '../../app.routes';
import { AuthService } from '../../core/services/auth.service';
import { ProductGuideService } from '../../core/services/product-guide.service';

describe('first steps entry', () => {
  const userId = 'guide-routing-test';
  const session = signal<any>({ user: { id: userId }, device: { id: 'phone' } });
  beforeEach(() => { localStorage.removeItem(`nivra.guide.v1.${userId}`); TestBed.configureTestingModule({ providers: [provideRouter([]), { provide: AuthService, useValue: { session } }] }); });
  afterEach(() => localStorage.removeItem(`nivra.guide.v1.${userId}`));
  const enter = (path: string[]) => TestBed.runInInjectionContext(() => firstSteps({}, path.map(p => new UrlSegment(p, {}))));
  it('introduces Nivra on the first plain chats entry', () => {
    expect(TestBed.inject(Router).serializeUrl(enter(['chats']) as any)).toBe('/app/guide');
  });
  it('keeps a conversation deep link and does not loop after skipping', () => {
    expect(enter(['chats', 'conversation-id'])).toBeTrue();
    TestBed.inject(ProductGuideService).introduce(userId);
    expect(enter(['chats'])).toBeTrue();
  });
});
