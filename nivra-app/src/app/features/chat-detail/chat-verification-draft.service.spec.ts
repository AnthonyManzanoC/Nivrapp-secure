import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AuthService } from '../../core/services/auth.service';
import { ChatVerificationDraftService } from './chat-verification-draft.service';

describe('verification draft memory handoff', () => {
  type Session = { user: { id: string }; device: { id: string } };
  let session: ReturnType<typeof signal<Session | null>>;
  let drafts: ChatVerificationDraftService;
  const signedIn = (user = 'alice', device = 'phone'): Session => ({ user: { id: user }, device: { id: device } });

  beforeEach(() => {
    session = signal<Session | null>(signedIn());
    TestBed.configureTestingModule({ providers: [{ provide: AuthService, useValue: { session } }] });
    drafts = TestBed.inject(ChatVerificationDraftService);
    TestBed.flushEffects();
  });

  it('returns a draft once and only to the conversation that opened verification', () => {
    drafts.save('direct', 'Mensaje que todavía no envié');
    expect(drafts.take('another-chat')).toBeNull();
    expect(drafts.take('direct')).toBe('Mensaje que todavía no envié');
    expect(drafts.take('direct')).toBeNull();
  });

  it('never writes message text into browser storage', () => {
    const persist = spyOn(Storage.prototype, 'setItem');
    drafts.save('direct', 'Borrador privado');
    expect(drafts.take('direct')).toBe('Borrador privado');
    expect(persist).not.toHaveBeenCalled();
  });

  it('clears the handoff on logout even when the same account signs in again', () => {
    drafts.save('direct', 'Texto anterior');
    session.set(null); TestBed.flushEffects();
    session.set(signedIn()); TestBed.flushEffects();
    expect(drafts.take('direct')).toBeNull();
  });

  it('clears the handoff after an account or device changes', () => {
    for (const next of [signedIn('bob'), signedIn('alice', 'desktop')]) {
      session.set(signedIn()); TestBed.flushEffects();
      drafts.save('direct', 'Solo en este dispositivo');
      session.set(next); TestBed.flushEffects();
      session.set(signedIn()); TestBed.flushEffects();
      expect(drafts.take('direct')).toBeNull();
    }
  });

  it('discards only the matching failed navigation and never saves without a session', () => {
    drafts.save('direct', 'Reintentar');
    drafts.discard('other');
    expect(drafts.take('direct')).toBe('Reintentar');
    drafts.save('direct', 'Otra vez'); drafts.discard('direct');
    expect(drafts.take('direct')).toBeNull();
    session.set(null); drafts.save('direct', 'No debe guardarse');
    session.set(signedIn());
    expect(drafts.take('direct')).toBeNull();
  });
});
