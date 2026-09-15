import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface ScreenSharePlugin {
  start(options: { sessionId: string; offer: string }): Promise<{ answer: string }>;
  stop(options: { sessionId: string }): Promise<void>;
  addListener(event: 'ended', handler: (event: { sessionId: string; reason: string }) => void): Promise<PluginListenerHandle>;
}
const NativeScreenShare = registerPlugin<ScreenSharePlugin>('NivraScreenShare');

/** Native MediaProjection -> local WebRTC -> browser video track.
 * No remote room, screen files, JavaScript frame copies or microphone capture.
 */
@Injectable({ providedIn: 'root' })
export class NativeScreenShareService {
  private sessionId = '';
  private peer: RTCPeerConnection | null = null;
  private stream: MediaStream | null = null;
  private listener: PluginListenerHandle | null = null;
  supported(): boolean { return Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('NivraScreenShare'); }

  async start(): Promise<MediaStream> {
    if (!this.supported()) throw new Error('Este dispositivo todavía no admite captura nativa de pantalla.');
    if (this.sessionId) throw new Error('Ya hay una captura de pantalla en curso.');
    const sessionId = crypto.randomUUID();
    this.sessionId = sessionId;
    const peer = new RTCPeerConnection({ iceServers: [], iceTransportPolicy: 'all' });
    this.peer = peer;
    const stream = new MediaStream();
    this.stream = stream;
    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });
    peer.ontrack = event => { if (this.sessionId === sessionId) stream.addTrack(event.track); else event.track.stop(); };
    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'failed' && this.sessionId === sessionId) void this.finish(sessionId, true);
    };
    try {
      const listener = await NativeScreenShare.addListener('ended', event => {
        if (event.sessionId === sessionId) void this.finish(sessionId, true);
      });
      if (this.sessionId !== sessionId) { await listener.remove(); throw new Error('La captura se canceló.'); }
      this.listener = listener;
      await peer.setLocalDescription(await peer.createOffer());
      await this.waitFor(() => peer.iceGatheringState === 'complete', sessionId, 5000);
      const result = await NativeScreenShare.start({ sessionId, offer: peer.localDescription!.sdp });
      if (this.sessionId !== sessionId) throw new Error('La captura se canceló.');
      await peer.setRemoteDescription({ type: 'answer', sdp: result.answer });
      await this.waitFor(() => stream.getVideoTracks().some(track => track.readyState === 'live') && peer.connectionState === 'connected', sessionId, 15000);
      return stream;
    } catch (error) { await this.finish(sessionId, false); throw error; }
  }

  stop(): Promise<void> { return this.finish(this.sessionId, false); }

  private async finish(sessionId: string, notifyEnded: boolean): Promise<void> {
    if (!sessionId || this.sessionId !== sessionId) return;
    this.sessionId = '';
    const peer = this.peer; const stream = this.stream; const listener = this.listener;
    this.peer = null; this.stream = null; this.listener = null;
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); }
    for (const track of stream?.getTracks() ?? []) { track.stop(); if (notifyEnded) track.dispatchEvent(new Event('ended')); }
    await Promise.allSettled([listener?.remove(), NativeScreenShare.stop({ sessionId })]);
  }

  private async waitFor(predicate: () => boolean, sessionId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (this.sessionId !== sessionId) throw new Error('La captura se canceló.');
      if (Date.now() >= deadline) throw new Error('No se pudo conectar la captura de pantalla del teléfono.');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
  }
}
