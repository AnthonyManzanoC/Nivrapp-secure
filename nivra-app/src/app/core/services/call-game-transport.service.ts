import { Injectable, OnDestroy, signal } from '@angular/core';
import { Room, RoomEvent, type RemoteParticipant } from 'livekit-client';
import { Subject } from 'rxjs';

export interface CallGamePacket { senderUserId: string; body: Record<string, unknown>; }
const CHANNEL = 'nivra-games-v1';
const TOPIC = 'nivra.games.v1';
const MAX_BYTES = 12_000;
const MAX_BUFFER = 64_000;

/** Small, bounded game messages share the connection, never the audio/video tracks. */
@Injectable({ providedIn: 'root' })
export class CallGameTransportService implements OnDestroy {
  readonly packets$ = new Subject<CallGamePacket>();
  readonly connectedPeers = signal<string[]>([]);
  private readonly channels = new Map<string, RTCDataChannel>();
  private readonly peerCleanup = new Map<string, () => void>();
  private readonly receivedAt = new Map<string, number[]>();
  private callId = '';
  private room: Room | null = null;
  private roomCleanup: (() => void) | null = null;
  private allowedUsers = new Set<string>();
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private groupQueue: Promise<void> = Promise.resolve();
  private queuedGroupPackets = 0;

  configure(callId: string, participants: string[]): void {
    if (this.callId && this.callId !== callId) { this.reset(); }
    this.callId = callId;
    this.allowedUsers = new Set(participants);
    this.connectedPeers.update(peers => peers.filter(id => this.allowedUsers.has(id)));
  }

  attachDirect(userId: string, connection: RTCPeerConnection, createChannel: boolean): void {
    this.detachPeer(userId);
    const receive = (event: RTCDataChannelEvent) => {
      if (event.channel.label === CHANNEL) { this.bindChannel(userId, event.channel); }
    };
    connection.addEventListener('datachannel', receive);
    this.peerCleanup.set(userId, () => connection.removeEventListener('datachannel', receive));
    // Exactly one endpoint creates the channel before its SDP offer. The other
    // endpoint receives `datachannel`; audio/video senders are left untouched.
    if (createChannel) {
      this.bindChannel(userId, connection.createDataChannel(CHANNEL, { ordered: true }));
    }
  }

  attachRoom(room: Room): void {
    this.roomCleanup?.();
    this.room = room;
    const update = () => this.connectedPeers.set([...room.remoteParticipants.keys()].filter((id) => this.allowedUsers.has(id)));
    const receive = (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic === TOPIC && participant?.identity) { this.receive(participant.identity, payload); }
    };
    room.on(RoomEvent.DataReceived, receive);
    room.on(RoomEvent.ParticipantConnected, update);
    room.on(RoomEvent.ParticipantDisconnected, update);
    room.on(RoomEvent.Connected, update);
    this.roomCleanup = () => {
      room.off(RoomEvent.DataReceived, receive);
      room.off(RoomEvent.ParticipantConnected, update);
      room.off(RoomEvent.ParticipantDisconnected, update);
      room.off(RoomEvent.Connected, update);
    };
    update();
  }

  async send(body: Record<string, unknown>, recipients = this.connectedPeers()): Promise<void> {
    const bytes = this.encoder.encode(JSON.stringify({ v: 1, callId: this.callId, body }));
    if (!this.callId || bytes.byteLength > MAX_BYTES) { throw new Error('El mensaje del juego supera el límite permitido.'); }
    const targets = [...new Set(recipients)].filter((id) => this.allowedUsers.has(id));
    if (!targets.length) { throw new Error('Espera a que otro participante se conecte al juego.'); }
    if (this.room) {
      if (this.queuedGroupPackets >= 16) { throw new Error('El juego está esperando a la red. Intenta en un momento.'); }
      const room = this.room;
      const callId = this.callId;
      this.queuedGroupPackets++;
      const pending = this.groupQueue.catch(() => undefined).then(async () => {
        if (this.room !== room || this.callId !== callId) throw new Error('La partida ya se cerró.');
        await room.localParticipant.publishData(bytes, { reliable: true, topic: TOPIC, destinationIdentities: targets });
      });
      this.groupQueue = pending;
      try { await pending; } finally { this.queuedGroupPackets--; }
      return;
    }
    const outputs = targets.map((id) => this.channels.get(id));
    if (outputs.some((channel) => !channel || channel.readyState !== 'open' || channel.bufferedAmount > MAX_BUFFER)) {
      throw new Error('El canal del juego está reconectando. Vuelve a intentar.');
    }
    outputs.forEach((channel) => channel!.send(bytes));
  }

  detachPeer(userId: string): void {
    this.peerCleanup.get(userId)?.();
    this.peerCleanup.delete(userId);
    const channel = this.channels.get(userId);
    if (channel) {
      channel.onmessage = null;
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.close();
    }
    this.channels.delete(userId);
    this.updateDirectPeers();
  }

  reset(): void {
    this.roomCleanup?.();
    this.roomCleanup = null;
    this.room = null;
    for (const id of [...this.peerCleanup.keys(), ...this.channels.keys()]) { this.detachPeer(id); }
    this.receivedAt.clear();
    this.allowedUsers.clear();
    this.connectedPeers.set([]);
    this.callId = '';
  }

  ngOnDestroy(): void { this.reset(); this.packets$.complete(); }

  private bindChannel(userId: string, channel: RTCDataChannel): void {
    const old = this.channels.get(userId);
    if (old && old !== channel) { channel.close(); return; }
    this.channels.set(userId, channel);
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.updateDirectPeers();
    channel.onclose = () => this.updateDirectPeers();
    channel.onerror = () => this.updateDirectPeers();
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) { this.receive(userId, new Uint8Array(event.data)); }
      else if (typeof event.data === 'string' && event.data.length <= MAX_BYTES) { this.receive(userId, this.encoder.encode(event.data)); }
    };
    this.updateDirectPeers();
  }

  private updateDirectPeers(): void {
    if (!this.room) {
      this.connectedPeers.set([...this.channels].filter(([, channel]) => channel.readyState === 'open').map(([id]) => id));
    }
  }

  private receive(senderUserId: string, bytes: Uint8Array): void {
    if (!this.allowedUsers.has(senderUserId) || bytes.byteLength > MAX_BYTES) { return; }
    const now = Date.now();
    const recent = (this.receivedAt.get(senderUserId) ?? []).filter((at) => now - at < 1_000);
    if (recent.length >= 25) { return; }
    recent.push(now);
    this.receivedAt.set(senderUserId, recent);
    try {
      const packet = JSON.parse(this.decoder.decode(bytes)) as { v?: unknown; callId?: unknown; body?: unknown };
      if (packet.v !== 1 || packet.callId !== this.callId || !packet.body || typeof packet.body !== 'object' || Array.isArray(packet.body)) { return; }
      this.packets$.next({ senderUserId, body: packet.body as Record<string, unknown> });
    } catch { /* Ignore malformed or unrelated data without affecting media. */ }
  }
}
