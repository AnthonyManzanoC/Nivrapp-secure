import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { ChatDetailPage } from './chat-detail.page';
import { ChatVerificationDraftService } from './chat-verification-draft.service';

describe('chat identity verification draft navigation', () => {
  let drafts: ChatVerificationDraftService;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: {
      session: signal({ user: { id: 'alice' }, device: { id: 'phone' } }),
    } }] });
    drafts = TestBed.inject(ChatVerificationDraftService); TestBed.flushEffects();
  });

  function page(draft = '') {
    const instance = Object.create(ChatDetailPage.prototype) as ChatDetailPage;
    const navigate = jasmine.createSpy('navigate').and.resolveTo(true);
    Object.assign(instance, {
      draft, destroyed: false, verificationDraft: drafts,
      auth: { session: () => ({ user: { id: 'alice' }, device: { id: 'phone' } }) },
      conversation: () => ({ id: 'direct', participants: [{ userId: 'alice' }, { userId: 'retired', removedAt: 'now' }, { userId: 'bob' }] }),
      isGroupConversation: () => false,
      router: { url: '/app/chats/direct?source=notification', navigate },
    });
    return { instance, navigate };
  }

  const restore = (instance: ChatDetailPage, id = 'direct') =>
    (instance as unknown as { restoreVerificationDraft: (conversationId: string) => void }).restoreVerificationDraft(id);

  it('preserves the text and exact return route without putting the draft into navigation history', async () => {
    const { instance, navigate } = page('Mi mensaje pendiente');
    await instance.verifyIdentity();
    expect(navigate).toHaveBeenCalledOnceWith(['/app/identity', 'bob'], { state: { identityReturnUrl: '/app/chats/direct?source=notification' } });
    expect(instance.draft).toBe('Mi mensaje pendiente');
    const recreated = page().instance;
    restore(recreated, 'other'); expect(recreated.draft).toBe('');
    restore(recreated); expect(recreated.draft).toBe('Mi mensaje pendiente');
    expect(drafts.take('direct')).toBeNull();
  });

  it('keeps any newer text on an Ionic cached page when returning from verification', async () => {
    const { instance } = page('Pendiente anterior'); await instance.verifyIdentity();
    instance.draft = 'Texto más reciente'; restore(instance);
    expect(instance.draft).toBe('Texto más reciente');
    expect(drafts.take('direct')).toBeNull();
  });

  it('drops the handoff if navigation is cancelled or fails while preserving the current draft', async () => {
    const { instance, navigate } = page('Reintentar aquí');
    navigate.and.resolveTo(false); await instance.verifyIdentity();
    expect(drafts.take('direct')).toBeNull(); expect(instance.draft).toBe('Reintentar aquí');
    navigate.and.rejectWith(new Error('Navigation failed')); await instance.verifyIdentity();
    expect(drafts.take('direct')).toBeNull(); expect(instance.draft).toBe('Reintentar aquí');
  });

  it('suppresses only the duplicate trust message while preserving other attachment errors', () => {
    const { instance } = page();
    spyOn(instance, 'identityChanged').and.returnValue(true);
    instance.attachmentError = 'La identidad de este contacto ha cambiado. Abre Verificar identidad y compara el código antes de continuar.';
    expect(instance.identityErrorIsDuplicated()).toBeTrue();
    instance.attachmentError = 'El archivo es demasiado grande';
    expect(instance.identityErrorIsDuplicated()).toBeFalse();
    (instance.identityChanged as jasmine.Spy).and.returnValue(false);
    instance.attachmentError = 'La identidad de este contacto ha cambiado. Abre Verificar identidad y compara el código antes de continuar.';
    expect(instance.identityErrorIsDuplicated()).toBeFalse();
  });
});
