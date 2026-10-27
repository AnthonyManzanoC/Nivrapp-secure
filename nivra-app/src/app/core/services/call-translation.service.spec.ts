import { signal } from '@angular/core';
import { fakeAsync, flushMicrotasks, TestBed, tick } from '@angular/core/testing';
import { AuthService } from './auth.service';
import { CallsService } from './calls.service';
import { AppSettingsService } from './app-settings.service';
import { CallTranslationEngine, type CallTranslationRequest } from './call-translation-engine';
import { CallTranslationService } from './call-translation.service';

describe('ephemeral call translation', () => {
  let service: CallTranslationService;
  let auth: any;
  let calls: any;
  let settings: any;
  let request: CallTranslationRequest;
  let engine: { start: jasmine.Spy; stop: jasmine.Spy };
  const track = { id: 'remote-audio', kind: 'audio', readyState: 'live' } as MediaStreamTrack;
  const stream = { getAudioTracks: () => [track] } as MediaStream;
  beforeEach(() => {
    localStorage.removeItem('nivra.callTranslation.v1:translation-a');
    localStorage.removeItem('nivra.callTranslation.v1:translation-b');
    auth = { session: signal({ user: { id: 'translation-a' }, device: { id: 'a-device' } }), sessionGeneration: signal(1) };
    calls = { activeCall: signal({ id: 'one' }), phase: signal('connected'), remoteEntries: signal([['peer', stream]]) };
    settings = { settings: signal({ showTranslateButton: true }) };
    engine = { start: jasmine.createSpy().and.callFake(async (value: CallTranslationRequest) => { request = value; }), stop: jasmine.createSpy().and.resolveTo() };
    TestBed.configureTestingModule({ providers: [
      { provide: AuthService, useValue: auth }, { provide: CallsService, useValue: calls },
      { provide: AppSettingsService, useValue: settings },
      { provide: CallTranslationEngine, useValue: engine },
    ] });
    service = TestBed.inject(CallTranslationService); TestBed.flushEffects();
  });
  afterEach(() => { service.stop(); localStorage.removeItem('nivra.callTranslation.v1:translation-a'); localStorage.removeItem('nivra.callTranslation.v1:translation-b'); });

  it('sends only the selected remote track and explicit user mode to the local engine', async () => {
    service.configure('both', 'en-US', 'es-ES');
    await service.start();
    expect(request.track).toBe(track); expect(request.mode).toBe('both');
    expect(service.active()).toBeTrue(); expect(service.busy()).toBeFalse();
    expect(request.sourceLanguage).toBe('en-US'); expect(request.targetLanguage).toBe('es-ES');
  });
  it('does not start automatically on a new call or from a stored preference', () => {
    service.configure('voice', 'fr-FR', 'es-ES'); calls.activeCall.set({ id: 'next' }); TestBed.flushEffects();
    expect(engine.start).not.toHaveBeenCalled(); expect(service.mode()).toBe('voice');
  });
  it('immediately hides captions and stops the engine when translation is disabled in account settings', async () => {
    await service.start(); request.caption({ original: 'hello', text: 'hola', final: true });
    const sessionId = request.sessionId;
    settings.settings.set({ showTranslateButton: false });
    expect(service.enabled()).toBeFalse(); expect(service.active()).toBeFalse(); expect(service.caption()).toBeNull();
    TestBed.flushEffects();
    expect(engine.stop).toHaveBeenCalledWith(sessionId); expect(calls.phase()).toBe('connected');
    await service.start(); expect(engine.start).toHaveBeenCalledTimes(1);
    settings.settings.set({ showTranslateButton: true }); TestBed.flushEffects();
    expect(service.enabled()).toBeTrue(); expect(service.active()).toBeFalse(); expect(engine.start).toHaveBeenCalledTimes(1);
  });
  it('cancels pending model preparation when the account translation setting is disabled', async () => {
    let complete!: () => void;
    engine.start.and.callFake((value: CallTranslationRequest) => { request = value; return new Promise<void>(resolve => { complete = resolve; }); });
    const pending = service.start(); const sessionId = request.sessionId;
    settings.settings.set({ showTranslateButton: false });
    expect(service.busy()).toBeFalse(); TestBed.flushEffects(); complete(); await pending;
    expect(engine.stop).toHaveBeenCalledWith(sessionId); expect(service.active()).toBeFalse();
    request.caption({ original: 'late', text: 'tarde', final: true }); expect(service.caption()).toBeNull();
  });
  it('keeps preferences separate and immediately discards captions when the account changes', async () => {
    service.configure('both', 'fr-FR', 'it-IT'); await service.start();
    request.caption({ original: 'bonjour', text: 'ciao', final: true }); expect(service.caption()?.text).toBe('ciao');
    const old = request;
    auth.session.set({ user: { id: 'translation-b' }, device: { id: 'b-device' } });
    // No effect flush: account A's caption must be hidden in the same read as B's identity.
    expect(service.caption()).toBeNull(); expect(service.active()).toBeFalse(); expect(service.busy()).toBeFalse();
    TestBed.flushEffects();
    expect(service.active()).toBeFalse(); expect(service.caption()).toBeNull(); expect(service.mode()).toBe('subtitles');
    old.caption({ original: 'old', text: 'old', final: true }); expect(service.caption()).toBeNull();
    expect(localStorage.getItem('nivra.callTranslation.v1:translation-a')).not.toContain('bonjour');
  });
  it('cancels a pending model preparation and refuses its delayed success', async () => {
    let complete!: () => void;
    engine.start.and.callFake((value: CallTranslationRequest) => { request = value; return new Promise<void>(resolve => { complete = resolve; }); });
    const pending = service.start(); service.stop(); complete(); await pending;
    expect(service.active()).toBeFalse(); expect(service.busy()).toBeFalse();
    expect(engine.stop).toHaveBeenCalledWith(request.sessionId);
  });
  it('isolates an A to B to A session generation while models are loading', async () => {
    let complete!: () => void;
    engine.start.and.callFake((value: CallTranslationRequest) => { request = value; return new Promise<void>(resolve => { complete = resolve; }); });
    const pending = service.start(); auth.sessionGeneration.set(3); TestBed.flushEffects(); complete(); await pending;
    expect(service.active()).toBeFalse(); request.caption({ original: 'stale', text: 'stale', final: true }); expect(service.caption()).toBeNull();
  });
  it('stops without interrupting the call when the track is replaced', async () => {
    await service.start(); const old = request;
    calls.remoteEntries.set([['peer', { getAudioTracks: () => [{ ...track, id: 'replacement' }] }]]); TestBed.flushEffects();
    expect(service.active()).toBeFalse(); expect(calls.phase()).toBe('connected');
    old.failure('stale'); expect(service.error()).not.toBe('stale');
  });
  it('stops and erases captions when the call ends', async () => {
    await service.start(); request.caption({ original: 'hello', text: 'hola', final: true });
    calls.activeCall.set(null); calls.phase.set('idle'); TestBed.flushEffects();
    expect(service.caption()).toBeNull(); expect(service.active()).toBeFalse();
  });
  it('releases captions when the engine reports that its remote track ended', async () => {
    await service.start(); request.caption({ original: 'hello', text: 'hola', final: true });
    try {
      (track as any).readyState = 'ended'; request.failure('Audio remoto detenido');
      expect(service.active()).toBeFalse(); expect(service.caption()).toBeNull(); expect(service.error()).toBe('Audio remoto detenido');
    } finally { (track as any).readyState = 'live'; }
  });
  it('clears an old engine warning when a different call begins', async () => {
    await service.start(); request.failure('No hay motor local');
    calls.activeCall.set({ id: 'different-call' }); expect(service.error()).toBe(''); TestBed.flushEffects();
    expect(service.error()).toBe(''); expect(service.active()).toBeFalse();
  });
  it('expires captions and never persists a transcript', fakeAsync(() => {
    void service.start(); flushMicrotasks(); request.caption({ original: 'private words', text: 'palabras privadas', final: true });
    tick(12_000); expect(service.caption()).toBeNull();
    expect(localStorage.getItem('nivra.callTranslation.v1:translation-a')).toBeNull();
  }));
  it('rejects start without connected remote audio', async () => {
    calls.phase.set('connecting'); await service.start();
    expect(engine.start).not.toHaveBeenCalled(); expect(service.error()).toContain('conecte');
  });
  it('validates preferences and leaves the live call intact on an engine failure', async () => {
    service.configure('invalid', 'arbitrary', 'arbitrary'); await service.start(); request.failure('Motor no disponible');
    expect(service.mode()).toBe('subtitles'); expect(service.source()).toBe('en-US');
    expect(service.active()).toBeFalse(); expect(service.error()).toBe('Motor no disponible'); expect(calls.phase()).toBe('connected');
  });
});
