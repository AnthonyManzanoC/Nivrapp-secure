import { DestroyRef, Injectable, NgZone, computed, effect, inject, signal, untracked } from '@angular/core';
import { AuthService } from './auth.service';
import { CallsService } from './calls.service';
import { AppSettingsService } from './app-settings.service';
import { CallTranslationEngine, type CallCaption, type CallTranslationMode } from './call-translation-engine';

export const CALL_TRANSLATION_LANGUAGES = [
  { code: 'es-ES', label: 'Español' }, { code: 'en-US', label: 'English' },
  { code: 'pt-BR', label: 'Português' }, { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' }, { code: 'it-IT', label: 'Italiano' },
  { code: 'ja-JP', label: '日本語' }, { code: 'ko-KR', label: '한국어' },
] as const;
const VALID_LANGUAGES = new Set<string>(CALL_TRANSLATION_LANGUAGES.map(item => item.code));
const VALID_MODES = new Set<string>(['subtitles', 'voice', 'both']);
type TranslationPreference = { mode: CallTranslationMode; source: string; target: string };

/** Ephemeral captions: preferences are scoped to the account; audio and text are never persisted. */
@Injectable({ providedIn: 'root' })
export class CallTranslationService {
  private readonly auth = inject(AuthService);
  private readonly calls = inject(CallsService);
  private readonly appSettings = inject(AppSettingsService);
  private readonly engine = inject(CallTranslationEngine);
  private readonly zone = inject(NgZone);
  private generation = 0;
  private sessionId = '';
  private context = '';
  private scope = '';
  private observedCallId = '';
  private expiry: ReturnType<typeof setTimeout> | undefined;
  readonly mode = signal<CallTranslationMode>('subtitles');
  readonly source = signal('en-US');
  readonly target = signal('es-ES');
  readonly peerId = signal('');
  readonly enabled = computed(() => this.appSettings.settings().showTranslateButton);
  private readonly busyState = signal(false);
  readonly busy = computed(() => this.enabled() && this.busyState() && this.contextMatches());
  private readonly activeState = signal(false);
  readonly active = computed(() => this.enabled() && this.activeState() && this.contextMatches());
  private readonly errorState = signal('');
  readonly error = computed(() => { const value = this.errorState(); return this.scope === this.accountScope() && this.observedCallId === (this.calls.activeCall()?.id ?? '') ? value : ''; });
  private readonly captionState = signal<CallCaption | null>(null);
  readonly caption = computed(() => { const value = this.captionState(); return this.enabled() && value && this.contextMatches() ? value : null; });
  readonly peers = computed(() => this.calls.remoteEntries().filter(([, stream]) =>
    stream.getAudioTracks?.().some(track => track.readyState === 'live')));
  readonly hasSubtitles = computed(() => this.mode() !== 'voice');

  constructor() {
    effect(() => {
      const scope = this.accountScope();
      const callId = this.calls.activeCall()?.id;
      const phase = this.calls.phase();
      const peers = this.peers();
      const enabled = this.enabled();
      untracked(() => {
        if (!enabled) { this.stop(); this.errorState.set(''); }
        if ((callId ?? '') !== this.observedCallId) {
          this.stop(); this.errorState.set(''); this.observedCallId = callId ?? '';
        }
        if (scope !== this.scope) {
          this.stop(); this.scope = scope; this.errorState.set(''); this.peerId.set(''); this.loadPreferences();
        }
        if (this.sessionId && (phase !== 'connected' || this.context !== this.currentContext())) {
          this.stop();
          if (callId && phase !== 'idle') this.errorState.set('La traducción se pausó al cambiar el audio o la conexión. Puedes activarla de nuevo.');
        }
        if (!peers.some(([id]) => id === this.peerId())) this.peerId.set(peers[0]?.[0] ?? '');
      });
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  configure(mode: string, source: string, target: string, peerId = this.peerId()): void {
    this.stop(); this.errorState.set('');
    this.mode.set(VALID_MODES.has(mode) ? mode as CallTranslationMode : 'subtitles');
    this.source.set(VALID_LANGUAGES.has(source) ? source : 'en-US');
    this.target.set(VALID_LANGUAGES.has(target) ? target : 'es-ES');
    this.peerId.set(peerId);
    const userId = this.auth.session()?.user.id;
    if (!userId) return;
    const preference: TranslationPreference = { mode: this.mode(), source: this.source(), target: this.target() };
    try { localStorage.setItem(`nivra.callTranslation.v1:${userId}`, JSON.stringify(preference)); } catch { /* Storage is optional. */ }
  }

  async start(): Promise<void> {
    this.stop(); this.errorState.set('');
    if (!this.enabled()) return;
    const track = this.selectedTrack();
    if (this.calls.phase() !== 'connected' || !this.auth.session() || !track) {
      this.errorState.set('Espera a que la llamada conecte y llegue el audio de la otra persona.'); return;
    }
    const generation = this.generation;
    const sessionId = crypto.randomUUID();
    const context = this.currentContext();
    const ownerScope = this.accountScope();
    const callId = this.calls.activeCall()!.id;
    this.sessionId = sessionId; this.context = context; this.busyState.set(true);
    const current = () => this.enabled() && generation === this.generation && this.sessionId === sessionId && this.currentContext() === context && this.calls.phase() === 'connected';
    try {
      await this.engine.start({ sessionId, track, sourceLanguage: this.source(), targetLanguage: this.target(), mode: this.mode(),
        caption: caption => this.zone.run(() => {
          if (!current()) return;
          this.captionState.set({ original: caption.original.slice(0, 600), text: caption.text.slice(0, 1_200), final: caption.final });
          if (this.expiry) clearTimeout(this.expiry);
          this.expiry = setTimeout(() => { if (current()) this.captionState.set(null); }, 12_000);
        }),
        failure: message => this.zone.run(() => {
          // A track-ended event necessarily changes currentContext. It still
          // belongs to this engine session and must release its caption/UI.
          if (generation !== this.generation || this.sessionId !== sessionId) return;
          const report = this.accountScope() === ownerScope && this.calls.activeCall()?.id === callId && this.calls.phase() === 'connected';
          this.stop(); if (report) this.errorState.set(message);
        }),
      });
      if (!current()) { await this.engine.stop(sessionId); return; }
      this.activeState.set(true);
    } catch (error) {
      if (current()) { this.stop(); this.errorState.set(error instanceof Error ? error.message : 'La traducción local no está disponible en este dispositivo.'); }
    } finally { if (generation === this.generation) this.busyState.set(false); }
  }

  stop(): void {
    ++this.generation;
    const sessionId = this.sessionId;
    this.sessionId = ''; this.context = ''; this.busyState.set(false); this.activeState.set(false); this.captionState.set(null);
    if (this.expiry) { clearTimeout(this.expiry); this.expiry = undefined; }
    if (sessionId) void this.engine.stop(sessionId);
  }

  private contextMatches(): boolean { return !!this.context && this.context === this.currentContext() && this.calls.phase() === 'connected'; }
  private selectedTrack(): MediaStreamTrack | undefined {
    return this.peers().find(([id]) => id === this.peerId())?.[1].getAudioTracks().find(track => track.readyState === 'live');
  }
  private accountScope(): string {
    const session = this.auth.session();
    return session ? `${session.user.id}|${session.device?.id ?? ''}|${this.auth.sessionGeneration?.() ?? 0}` : '';
  }
  private currentContext(): string { return `${this.accountScope()}|${this.calls.activeCall()?.id ?? ''}|${this.peerId()}|${this.selectedTrack()?.id ?? ''}`; }
  private loadPreferences(): void {
    this.mode.set('subtitles'); this.source.set('en-US'); this.target.set('es-ES');
    const userId = this.auth.session()?.user.id;
    if (!userId) return;
    try {
      const value = JSON.parse(localStorage.getItem(`nivra.callTranslation.v1:${userId}`) ?? '{}') as Partial<TranslationPreference>;
      if (value.mode && VALID_MODES.has(value.mode)) this.mode.set(value.mode);
      if (value.source && VALID_LANGUAGES.has(value.source)) this.source.set(value.source);
      if (value.target && VALID_LANGUAGES.has(value.target)) this.target.set(value.target);
    } catch { /* Malformed optional preferences must never interrupt a call. */ }
  }
}
