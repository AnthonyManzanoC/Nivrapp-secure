import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export type CallTranslationMode = 'subtitles' | 'voice' | 'both';
export interface CallCaption { original: string; text: string; final: boolean; }
export interface CallTranslationRequest {
  sessionId: string; track: MediaStreamTrack; sourceLanguage: string; targetLanguage: string;
  mode: CallTranslationMode; caption: (caption: CallCaption) => void; failure: (message: string) => void;
}
interface NativeTranslation {
  start(options: { sessionId: string; sourceLanguage: string; targetLanguage: string; voice: boolean }): Promise<void>;
  feedPcm(options: { sessionId: string; base64: string }): Promise<void>;
  stop(options: { sessionId: string }): Promise<void>;
  addListener(event: 'caption', listener: (value: CallCaption & { sessionId: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'failure', listener: (value: { sessionId: string; message: string }) => void): Promise<PluginListenerHandle>;
}
const nativeTranslation = registerPlugin<NativeTranslation>('CallTranslation');

interface LocalRecognition {
  processLocally: boolean; lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null; onend: (() => void) | null;
  start(track: MediaStreamTrack): void; abort(): void;
}
interface RecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface LocalRecognitionConstructor {
  new(): LocalRecognition;
  available(options: { langs: string[]; processLocally: true }): Promise<string>;
  install(options: { langs: string[]; processLocally: true }): Promise<boolean>;
}
interface LocalTranslator { translate(text: string): Promise<string>; destroy(): void; }
interface LocalTranslatorConstructor {
  availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<LocalTranslator>;
}
type TranslationWindow = Window & {
  SpeechRecognition?: LocalRecognitionConstructor;
  Translator?: LocalTranslatorConstructor;
};
type EngineSession = {
  request: CallTranslationRequest; stopped: boolean; recognition?: LocalRecognition; translator?: LocalTranslator;
  listeners: PluginListenerHandle[]; context?: AudioContext; source?: MediaStreamAudioSourceNode;
  processor?: AudioWorkletNode; silent?: GainNode; restartTimer?: ReturnType<typeof setTimeout>;
  queue: string[]; translating: boolean; feedPending: boolean; voice?: SpeechSynthesisVoice;
  utterance?: SpeechSynthesisUtterance;
  trackEnded?: () => void;
};

/** Receives only a remote audio track. It never opens another microphone or uses cloud speech. */
@Injectable({ providedIn: 'root' })
export class CallTranslationEngine {
  private readonly sessions = new Map<string, EngineSession>();

  async start(request: CallTranslationRequest): Promise<void> {
    if (request.track.kind !== 'audio' || request.track.readyState !== 'live') throw new Error('Espera a que llegue el audio de la otra persona.');
    const session: EngineSession = { request, stopped: false, listeners: [], queue: [], translating: false, feedPending: false };
    this.sessions.set(request.sessionId, session);
    session.trackEnded = () => this.fail(session, 'El audio de esa persona se detuvo. Puedes activar la traducción cuando vuelva a conectarse.');
    request.track.addEventListener?.('ended', session.trackEnded);
    try {
      if (Capacitor.getPlatform() === 'android') await this.startNative(session);
      else await this.startBrowser(session);
    } catch (error) {
      await this.stop(request.sessionId);
      throw error;
    }
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopped = true;
    this.sessions.delete(sessionId);
    if (session.trackEnded) session.request.track.removeEventListener?.('ended', session.trackEnded);
    const cleanups: Promise<unknown>[] = [];
    // Send cancellation before waiting for Web Audio or a model teardown.
    if (Capacitor.getPlatform() === 'android') cleanups.push(nativeTranslation.stop({ sessionId }).catch(() => undefined));
    if (session.restartTimer) clearTimeout(session.restartTimer);
    if (session.recognition) {
      session.recognition.onend = session.recognition.onerror = session.recognition.onresult = null;
      try { session.recognition.abort(); } catch { /* Recognition may not have started. */ }
    }
    try { session.translator?.destroy(); } catch { /* A model failure must not skip remaining cleanup. */ }
    session.queue.length = 0;
    // Only cancel speech that this translation session owns.
    if (session.utterance) {
      session.utterance.onerror = null;
      try { if (globalThis.speechSynthesis?.speaking) globalThis.speechSynthesis.cancel(); } catch { /* Continue cleanup. */ }
    }
    if (session.processor) session.processor.port.onmessage = null;
    for (const node of [session.processor, session.source, session.silent]) {
      try { node?.disconnect(); } catch { /* Detached or closed nodes are already safe. */ }
    }
    if (session.context && session.context.state !== 'closed') cleanups.push(Promise.resolve().then(() => session.context!.close()));
    cleanups.push(...session.listeners.map(listener => Promise.resolve().then(() => listener.remove())));
    await Promise.allSettled(cleanups);
  }

  private alive(session: EngineSession): boolean { return !session.stopped && this.sessions.get(session.request.sessionId) === session; }
  private fail(session: EngineSession, message: string): void {
    if (!this.alive(session)) return;
    session.request.failure(message);
    void this.stop(session.request.sessionId);
  }

  private async startNative(session: EngineSession): Promise<void> {
    const request = session.request;
    for (const [event, listener] of [
      ['caption', (value: CallCaption & { sessionId: string }) => {
        if (this.alive(session) && value.sessionId === request.sessionId) request.caption(value);
      }],
      ['failure', (value: { sessionId: string; message: string }) => {
        if (value.sessionId === request.sessionId) this.fail(session, value.message);
      }],
    ] as const) {
      const handle = await (nativeTranslation.addListener as Function)(event, listener) as PluginListenerHandle;
      if (!this.alive(session)) { await handle.remove(); return; }
      session.listeners.push(handle);
    }
    await nativeTranslation.start({ sessionId: request.sessionId, sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage, voice: request.mode !== 'subtitles' });
    if (!this.alive(session)) { await nativeTranslation.stop({ sessionId: request.sessionId }); return; }
    // The worklet runs off the UI thread. Web Audio resamples the remote track to 16 kHz.
    const context = new AudioContext({ sampleRate: 16_000 });
    session.context = context;
    await context.audioWorklet.addModule(new URL('assets/call-translation-worklet.js', document.baseURI).href);
    if (!this.alive(session)) return;
    if (context.sampleRate !== 16_000) throw new Error('Este dispositivo no admite el audio local necesario para traducir.');
    const processor = new AudioWorkletNode(context, 'nivra-call-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    session.processor = processor;
    session.source = context.createMediaStreamSource(new MediaStream([request.track]));
    session.silent = context.createGain(); session.silent.gain.value = 0;
    processor.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!this.alive(session)) return;
      // Backpressure is bounded: an overloaded bridge stops translation, never the call.
      if (session.feedPending) { this.fail(session, 'La traducción se pausó por carga del dispositivo. Puedes activarla de nuevo.'); return; }
      const bytes = new Uint8Array(event.data);
      if (bytes.byteLength !== 6_400) { this.fail(session, 'No se pudo preparar el audio para traducir.'); return; }
      session.feedPending = true;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      void nativeTranslation.feedPcm({ sessionId: request.sessionId, base64: btoa(binary) })
        .catch(() => this.fail(session, 'La traducción se pausó. La llamada continúa.'))
        .finally(() => { session.feedPending = false; });
    };
    session.source.connect(processor); processor.connect(session.silent); session.silent.connect(context.destination);
    await context.resume();
  }

  private async startBrowser(session: EngineSession): Promise<void> {
    const root = window as TranslationWindow;
    const Recognition = root.SpeechRecognition;
    // Requiring the local API avoids the legacy webkit recognizer's cloud fallback.
    if (!Recognition?.available || !Recognition.install) throw new Error('Este navegador no tiene reconocimiento local compatible. Prueba Chrome de escritorio actualizado o Android 13 con un motor local compatible.');
    const recognition = new Recognition();
    if (!('processLocally' in recognition)) throw new Error('El reconocimiento local no está disponible en este navegador.');
    session.recognition = recognition;
    recognition.processLocally = true;
    recognition.lang = session.request.sourceLanguage;
    recognition.continuous = true; recognition.interimResults = true;
    const options = { langs: [session.request.sourceLanguage], processLocally: true as const };
    const available = await Recognition.available(options);
    if (!this.alive(session)) return;
    if (available !== 'available') {
      if (available !== 'downloadable' || !await Recognition.install(options)) throw new Error('Instala el idioma de reconocimiento local en el navegador y vuelve a intentarlo.');
      if (!this.alive(session)) return;
    }
    const sourceLanguage = session.request.sourceLanguage.split('-')[0];
    const targetLanguage = session.request.targetLanguage.split('-')[0];
    if (sourceLanguage !== targetLanguage) {
      if (!root.Translator || await root.Translator.availability({ sourceLanguage, targetLanguage }) === 'unavailable') throw new Error('La traducción local entre esos idiomas no está disponible en este navegador.');
      if (!this.alive(session)) return;
      const translator = await root.Translator.create({ sourceLanguage, targetLanguage });
      if (!this.alive(session)) { translator.destroy(); return; }
      session.translator = translator;
    }
    if (session.request.mode !== 'subtitles') {
      const voice = globalThis.speechSynthesis?.getVoices().find(item => item.localService && item.lang.split('-')[0] === targetLanguage);
      if (!voice) throw new Error('No hay una voz local instalada para ese idioma. Elige Subtítulos o instala una voz del sistema.');
      session.voice = voice;
    }
    recognition.onresult = event => {
      if (!this.alive(session)) return;
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index];
        const original = result[0].transcript.trim().slice(0, 600);
        if (!original) continue;
        if (!result.isFinal) { session.request.caption({ original, text: '', final: false }); continue; }
        if (session.queue.length >= 3) { this.fail(session, 'La traducción no pudo seguir el ritmo del audio. Puedes activarla de nuevo.'); return; }
        session.queue.push(original); void this.translateQueue(session);
      }
    };
    recognition.onerror = event => {
      if (event.error === 'no-speech') return;
      this.fail(session, 'El motor local no pudo transcribir el audio. La llamada continúa; comprueba el idioma y sus modelos.');
    };
    recognition.onend = () => {
      if (!this.alive(session)) return;
      session.restartTimer = setTimeout(() => {
        if (!this.alive(session) || session.request.track.readyState !== 'live') return;
        try { recognition.start(session.request.track); }
        catch { this.fail(session, 'No se pudo reanudar la transcripción local.'); }
      }, 300);
    };
    if (this.alive(session)) recognition.start(session.request.track);
  }

  private async translateQueue(session: EngineSession): Promise<void> {
    if (session.translating) return;
    session.translating = true;
    try {
      while (this.alive(session) && session.queue.length) {
        const original = session.queue.shift()!;
        const text = session.translator ? await session.translator.translate(original) : original;
        if (!this.alive(session)) return;
        session.request.caption({ original, text: text.slice(0, 1_200), final: true });
        if (session.voice) {
          // Never build an unbounded speech backlog or choose a network voice.
          if (session.utterance) { session.utterance.onerror = null; globalThis.speechSynthesis.cancel(); }
          const utterance = new SpeechSynthesisUtterance(text.slice(0, 1_200));
          utterance.voice = session.voice; utterance.lang = session.voice.lang;
          session.utterance = utterance;
          utterance.onend = () => { if (session.utterance === utterance) session.utterance = undefined; };
          utterance.onerror = () => this.fail(session, 'No se pudo reproducir la voz local. Prueba con Subtítulos.');
          globalThis.speechSynthesis.speak(utterance);
        }
      }
    } catch { this.fail(session, 'No se pudo traducir esta frase en el dispositivo. La llamada continúa.'); }
    finally { session.translating = false; }
  }
}
