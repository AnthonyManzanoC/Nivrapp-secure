import { Capacitor } from '@capacitor/core';
import { CallTranslationEngine, type CallTranslationRequest } from './call-translation-engine';

describe('local call translation engine', () => {
  let engine: CallTranslationEngine;
  let request: CallTranslationRequest;
  let recognition: any;
  let descriptor: PropertyDescriptor | undefined;
  let translatorDescriptor: PropertyDescriptor | undefined;
  let translator: any;
  let available: jasmine.Spy;
  let install: jasmine.Spy;

  beforeEach(() => {
    spyOn(Capacitor, 'getPlatform').and.returnValue('web');
    descriptor = Object.getOwnPropertyDescriptor(window, 'SpeechRecognition');
    translatorDescriptor = Object.getOwnPropertyDescriptor(window, 'Translator');
    available = jasmine.createSpy().and.resolveTo('available'); install = jasmine.createSpy().and.resolveTo(true);
    class Recognition {
      static available = available; static install = install;
      processLocally = false; lang = ''; continuous = false; interimResults = false;
      onresult: Function | null = null; onerror: Function | null = null; onend: Function | null = null;
      start = jasmine.createSpy(); abort = jasmine.createSpy();
      constructor() { recognition = this; }
    }
    translator = { translate: jasmine.createSpy().and.resolveTo('hola'), destroy: jasmine.createSpy() };
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: Recognition });
    Object.defineProperty(window, 'Translator', { configurable: true, value: {
      availability: jasmine.createSpy().and.resolveTo('available'), create: jasmine.createSpy().and.resolveTo(translator),
    } });
    engine = new CallTranslationEngine();
    request = { sessionId: 'translation-test', track: Object.assign(new EventTarget(), { id: 'remote', kind: 'audio', readyState: 'live' }) as MediaStreamTrack,
      sourceLanguage: 'en-US', targetLanguage: 'es-ES', mode: 'subtitles', caption: jasmine.createSpy(), failure: jasmine.createSpy() };
  });
  afterEach(async () => {
    await engine.stop(request.sessionId);
    if (descriptor) Object.defineProperty(window, 'SpeechRecognition', descriptor); else delete (window as any).SpeechRecognition;
    if (translatorDescriptor) Object.defineProperty(window, 'Translator', translatorDescriptor); else delete (window as any).Translator;
  });
  it('uses the actual remote audio track and requires local processing', async () => {
    await engine.start(request);
    expect(recognition.processLocally).toBeTrue(); expect(recognition.start).toHaveBeenCalledOnceWith(request.track);
    expect(available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
  });
  it('fails closed instead of using the legacy cloud recognizer', async () => {
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
    await expectAsync(engine.start(request)).toBeRejectedWithError(/reconocimiento local/);
  });
  it('never starts the recognizer if the local language cannot be installed', async () => {
    available.and.resolveTo('unavailable'); await expectAsync(engine.start(request)).toBeRejectedWithError(/Instala/);
    expect(recognition.start).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it('downloads a supported language only during explicit start', async () => {
    available.and.resolveTo('downloadable'); expect(install).not.toHaveBeenCalled(); await engine.start(request);
    expect(install).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true }); expect(recognition.start).toHaveBeenCalled();
  });
  it('translates only final segments and reports partial results separately', async () => {
    await engine.start(request);
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hel' } }] });
    expect(translator.translate).not.toHaveBeenCalled();
    recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello' } }] });
    await Promise.resolve(); await Promise.resolve();
    expect(translator.translate).toHaveBeenCalledOnceWith('hello');
    expect(request.caption).toHaveBeenCalledWith({ original: 'hello', text: 'hola', final: true });
  });
  it('erases a delayed translation after stop and leaves the remote media track alone', async () => {
    let complete!: (text: string) => void;
    translator.translate.and.returnValue(new Promise<string>(resolve => { complete = resolve; }));
    const stopTrack = jasmine.createSpy(); (request.track as any).stop = stopTrack;
    await engine.start(request); recognition.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello' } }] });
    await engine.stop(request.sessionId); complete('hola'); await Promise.resolve(); await Promise.resolve();
    expect(request.caption).not.toHaveBeenCalled(); expect(translator.destroy).toHaveBeenCalled(); expect(stopTrack).not.toHaveBeenCalled();
  });
  it('destroys a model created after cancellation without starting recognition', async () => {
    let complete!: (value: unknown) => void;
    (window as any).Translator.create.and.returnValue(new Promise(resolve => { complete = resolve; }));
    const pending = engine.start(request);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await engine.stop(request.sessionId); complete(translator); await pending;
    expect(translator.destroy).toHaveBeenCalled(); expect(recognition.start).not.toHaveBeenCalled();
  });
  it('refuses voice mode when there are only network voices', async () => {
    spyOn(window.speechSynthesis, 'getVoices').and.returnValue([{ localService: false, lang: 'es-ES' } as SpeechSynthesisVoice]);
    request.mode = 'voice'; await expectAsync(engine.start(request)).toBeRejectedWithError(/voz local/);
    expect(recognition.start).not.toHaveBeenCalled();
  });
  it('does not let an old recognition callback fail another session', async () => {
    await engine.start(request); const old = recognition.onerror; await engine.stop(request.sessionId);
    old({ error: 'not-allowed' }); expect(request.failure).not.toHaveBeenCalled();
  });
  it('stops if the remote track ends without replacing the stream', async () => {
    await engine.start(request); request.track.dispatchEvent(new Event('ended'));
    expect(request.failure).toHaveBeenCalled(); expect(recognition.abort).toHaveBeenCalled();
  });
  it('completes teardown even when a local model throws while being destroyed', async () => {
    await engine.start(request); translator.destroy.and.throwError('model teardown failed');
    await expectAsync(engine.stop(request.sessionId)).toBeResolved();
    expect(recognition.abort).toHaveBeenCalled(); expect(recognition.onresult).toBeNull();
  });
});
