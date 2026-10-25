import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { NivraNative } from './native-plugin';

export type CallAudioRouteKind = 'earpiece' | 'speaker' | 'bluetooth' | 'wired' | 'usb' | 'default';
export interface CallAudioRoute { id: string; label: string; kind: CallAudioRouteKind; }
interface NativeCallAudioState {
  callId: string;
  supported: boolean;
  routes: CallAudioRoute[];
  selectedRouteId: string;
  pendingRouteId?: string;
  bluetoothPermission?: boolean;
  errorCode?: string;
  revision?: number;
}
interface NativeCallAudioBridge {
  configureCallAudio(options: { callId: string; active: boolean; video: boolean }): Promise<NativeCallAudioState>;
  getCallAudioRoutes(options: { requestPermission?: boolean }): Promise<NativeCallAudioState>;
  selectCallAudioRoute(options: { callId: string; routeId: string }): Promise<NativeCallAudioState>;
  addListener(event: 'nativeCallAudioRoutes', callback: (state: NativeCallAudioState) => void): Promise<PluginListenerHandle>;
}
type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
type OutputPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

/** Audio belongs to the call lifetime, independently of routed video views. */
@Injectable({ providedIn: 'root' })
export class CallAudioOutputService implements OnDestroy {
  private readonly outputs = new Map<string, HTMLAudioElement>();
  private readonly blocked = new Set<string>();
  readonly playbackBlocked = signal(false);
  readonly availableRoutes = signal<CallAudioRoute[]>([]);
  readonly selectedRouteId = signal('default');
  readonly routeBusy = signal(false);
  readonly routeError = signal('');
  readonly routingSupported = signal(false);
  readonly bluetoothPermission = signal(true);
  readonly selectedRouteLabel = computed(() => this.availableRoutes().find(route => route.id === this.selectedRouteId())?.label || 'Salida del sistema');
  readonly systemPickerSupported = !Capacitor.isNativePlatform() && typeof (navigator.mediaDevices as OutputPicker | undefined)?.selectAudioOutput === 'function';
  private readonly native = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android';
  private readonly nativeBridge = NivraNative as unknown as NativeCallAudioBridge;
  private nativeListener?: Promise<PluginListenerHandle>;
  private nativeQueue: Promise<unknown> = Promise.resolve();
  private sessionId = '';
  private sessionVideo = false;
  private routeEpoch = 0;
  private refreshEpoch = 0;
  private nativeRevision = -1;
  private requestedWebRoute = 'default';
  private readonly deviceChange = () => { if (this.sessionId) void this.refreshRoutes(); };
  private readonly resumeHandler = () => { void this.resume(); };
  private readonly visibilityHandler = () => {
    if (document.visibilityState === 'visible') { void this.resume(); }
  };

  constructor() {
    document.addEventListener('pointerdown', this.resumeHandler);
    document.addEventListener('keydown', this.resumeHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
    if (!this.native) navigator.mediaDevices?.addEventListener?.('devicechange', this.deviceChange);
  }

  /** Call identity owns routing; changing pages must never release the route. */
  setCallSession(callId: string | null, video = false): void {
    const next = callId || '';
    if (next === this.sessionId && video === this.sessionVideo) return;
    const previous = this.sessionId;
    const changed = next !== previous;
    this.sessionId = next;
    this.sessionVideo = video;
    const epoch = changed ? ++this.routeEpoch : this.routeEpoch;
    if (changed) {
      this.routeError.set('');
      this.routeBusy.set(false);
      this.selectedRouteId.set('default');
      this.requestedWebRoute = 'default';
      this.availableRoutes.set([]);
    }
    if (this.native) {
      if (next && !this.nativeListener) {
        this.nativeListener = this.nativeBridge.addListener('nativeCallAudioRoutes', state => {
          if (state.callId === this.sessionId && this.sessionId) this.adoptNativeState(state);
        });
        void this.nativeListener.catch(() => { this.nativeListener = undefined; });
      }
      void this.enqueue(async () => {
        if (changed && previous) await this.nativeBridge.configureCallAudio({ callId: previous, active: false, video: false }).catch(() => undefined);
        if (epoch !== this.routeEpoch || !next) return;
        this.routeBusy.set(true);
        try {
          const state = await this.nativeBridge.configureCallAudio({ callId: next, active: true, video });
          if (epoch === this.routeEpoch) this.adoptNativeState(state);
        } catch {
          if (epoch === this.routeEpoch) { this.routeBusy.set(false); this.routeError.set('No se pudo preparar la salida de la llamada.'); }
        }
      });
    } else if (next) void this.refreshRoutes();
  }

  async refreshRoutes(requestPermission = false): Promise<void> {
    const epoch = this.routeEpoch;
    const refresh = ++this.refreshEpoch;
    if (this.native) {
      await this.enqueue(async () => {
        if (!this.sessionId || epoch !== this.routeEpoch) return;
        try {
          const state = await this.nativeBridge.getCallAudioRoutes({ requestPermission });
          if (epoch === this.routeEpoch) this.adoptNativeState(state);
        } catch { if (epoch === this.routeEpoch) this.routeError.set('No se pudieron consultar las salidas de audio.'); }
      });
      return;
    }
    const supported = typeof (HTMLMediaElement.prototype as unknown as SinkAudio).setSinkId === 'function';
    this.routingSupported.set(supported);
    let routes: CallAudioRoute[] = [{ id: 'default', label: 'Salida del sistema', kind: 'default' }];
    try {
      if (supported && navigator.mediaDevices?.enumerateDevices) {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (epoch !== this.routeEpoch || refresh !== this.refreshEpoch) return;
        routes = routes.concat(devices.filter(device => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'default')
          .map((device, index) => ({ id: device.deviceId, label: device.label || `Salida de audio ${index + 1}`, kind: 'default' as const })));
      }
      if (epoch !== this.routeEpoch || refresh !== this.refreshEpoch) return;
      this.availableRoutes.set(routes);
      if (!routes.some(route => route.id === this.selectedRouteId())) await this.selectRoute('default');
    } catch { if (epoch === this.routeEpoch) this.routeError.set('No se pudieron consultar las salidas de audio.'); }
  }

  async chooseSystemOutput(): Promise<boolean> {
    const devices = navigator.mediaDevices as OutputPicker | undefined;
    if (this.native || !this.sessionId || !devices?.selectAudioOutput) return false;
    const epoch = this.routeEpoch;
    try {
      // Invoke directly inside the click gesture, before any awaited work.
      const selected = await devices.selectAudioOutput();
      if (epoch !== this.routeEpoch) return false;
      await this.refreshRoutes();
      return this.selectRoute(selected.deviceId);
    } catch { if (epoch === this.routeEpoch) this.routeError.set('No se autorizó otra salida de audio.'); return false; }
  }

  async selectRoute(id: string): Promise<boolean> {
    const epoch = this.routeEpoch;
    const callId = this.sessionId;
    if (!callId || !this.availableRoutes().some(route => route.id === id)) return false;
    return this.enqueue(async () => {
      if (epoch !== this.routeEpoch || callId !== this.sessionId) return false;
      this.routeBusy.set(true);
      this.routeError.set('');
      try {
        if (this.native) {
          const state = await this.nativeBridge.selectCallAudioRoute({ callId, routeId: id });
          if (epoch !== this.routeEpoch) return false;
          this.adoptNativeState(state);
          return !state.errorCode;
        }
        if (!this.routingSupported()) return false;
        const previous = this.selectedRouteId();
        const outputs = [...this.outputs.values()];
        this.requestedWebRoute = id;
        try {
          const probe = document.createElement('audio') as SinkAudio;
          await probe.setSinkId!(id === 'default' ? '' : id);
          if (epoch !== this.routeEpoch) return false;
          await Promise.all(outputs.map(output => this.setWebSink(output, id)));
          if (epoch !== this.routeEpoch) return false;
          this.selectedRouteId.set(id);
          return true;
        } catch (error) {
          if (epoch === this.routeEpoch) {
            this.requestedWebRoute = previous;
            await Promise.allSettled([...this.outputs.values()].map(output => this.setWebSink(output, previous)));
          }
          throw error;
        }
      } catch {
        if (epoch === this.routeEpoch) {
          this.routeBusy.set(false);
          this.routeError.set('No se pudo usar esa salida. Comprueba que siga conectada y vuelve a elegirla.');
        }
        return false;
      } finally {
        if (epoch === this.routeEpoch && !this.native) this.routeBusy.set(false);
      }
    });
  }

  sync(streams: Record<string, MediaStream>, muted: boolean): void {
    const active = new Set<string>();
    // A media element may select only one audio track. Render microphone and
    // shared system audio separately, without ever playing an incoming track twice.
    const tracks = new Map(Object.values(streams).flatMap(stream => stream.getAudioTracks())
      .filter(track => track.readyState !== 'ended').map(track => [track.id, track]));
    for (const [id, track] of tracks) {
      active.add(id);
      let output = this.outputs.get(id);
      if (!output) {
        output = document.createElement('audio');
        output.autoplay = true;
        output.setAttribute('playsinline', '');
        output.setAttribute('aria-hidden', 'true');
        output.hidden = true;
        document.body.appendChild(output);
        this.outputs.set(id, output);
      }
      output.muted = muted;
      const previous = output.srcObject as MediaStream | null;
      if (!previous || previous.getAudioTracks()[0] !== track) {
        output.srcObject = new MediaStream([track]);
      }
      void this.prepareAndPlay(id, output);
    }
    for (const [id, output] of this.outputs) {
      if (active.has(id)) { continue; }
      output.pause();
      output.srcObject = null;
      output.remove();
      this.outputs.delete(id);
      this.blocked.delete(id);
    }
    this.playbackBlocked.set(!muted && this.blocked.size > 0);
  }

  async resume(): Promise<void> {
    await Promise.all([...this.outputs].map(([id, output]) => this.play(id, output)));
  }

  ngOnDestroy(): void {
    document.removeEventListener('pointerdown', this.resumeHandler);
    document.removeEventListener('keydown', this.resumeHandler);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.deviceChange);
    this.setCallSession(null);
    void this.nativeListener?.then(handle => handle.remove()).catch(() => undefined);
    this.sync({}, false);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.nativeQueue.then(work, work);
    this.nativeQueue = pending.catch(() => undefined);
    return pending;
  }

  private adoptNativeState(state: NativeCallAudioState): void {
    if (!this.sessionId || state.callId !== this.sessionId) return;
    if (typeof state.revision === 'number') {
      if (state.revision < this.nativeRevision) return;
      this.nativeRevision = state.revision;
    }
    const kinds: string[] = ['earpiece', 'speaker', 'bluetooth', 'wired', 'usb', 'default'];
    this.availableRoutes.set((state.routes || []).filter(route => typeof route.id === 'string' && kinds.includes(route.kind))
      .map(route => ({ ...route, label: String(route.label || 'Salida de audio').slice(0, 80) })));
    this.selectedRouteId.set(state.selectedRouteId || 'default');
    this.routeBusy.set(Boolean(state.pendingRouteId));
    this.routingSupported.set(state.supported === true);
    this.bluetoothPermission.set(state.bluetoothPermission !== false);
    this.routeError.set(state.errorCode ? 'No se pudo conectar esa salida de audio. Puedes elegir otra.' : '');
  }

  private async setWebSink(output: HTMLAudioElement, route: string): Promise<void> {
    const sink = output as SinkAudio;
    if (typeof sink.setSinkId === 'function') await sink.setSinkId(route === 'default' ? '' : route);
  }

  private async prepareAndPlay(id: string, output: HTMLAudioElement): Promise<void> {
    const epoch = this.routeEpoch;
    if (!this.native && this.requestedWebRoute !== 'default') {
      try { await this.setWebSink(output, this.requestedWebRoute); }
      catch { if (epoch === this.routeEpoch) this.routeError.set('La salida elegida ya no está disponible. Elige otra salida de audio.'); }
      if (this.outputs.get(id) !== output) return;
    }
    await this.play(id, output);
  }

  private async play(id: string, output: HTMLAudioElement): Promise<void> {
    if (!output.paused && !this.blocked.has(id)) { return; }
    try {
      await output.play();
      if (this.outputs.get(id) !== output) { return; }
      this.blocked.delete(id);
    } catch (error) {
      // Stream replacement can abort play; only user activation needs a prompt.
      if (error instanceof DOMException && error.name === 'NotAllowedError' && this.outputs.get(id) === output) {
        this.blocked.add(id);
      }
    }
    if (this.outputs.get(id) === output) {
      this.playbackBlocked.set([...this.blocked].some((key) => this.outputs.get(key)?.muted === false));
    }
  }
}
