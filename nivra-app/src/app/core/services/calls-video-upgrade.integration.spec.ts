import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { CallsService } from './calls.service';
import { AuthService } from './auth.service';
import { CallAudioOutputService } from './call-audio-output.service';
import { CallGameSessionService } from './call-game-session.service';
import { GroupCallCryptoService } from './group-call-crypto.service';
import { NativeScreenShareService } from './native-screen-share.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { CallSession } from '../models/nivra.models';

describe('direct video upgrade browser integration', () => {
  let service: CallsService;
  let api: { post: jasmine.Spy; get: jasmine.Spy; patch: jasmine.Spy };
  const invitation: CallSession = {
    id: 'incoming', initiatorUserId: 'peer', participantUserIds: ['me', 'peer'],
    type: 'Voice', status: 'Ringing', startedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    api = {
      post: jasmine.createSpy().and.returnValue(of(invitation)),
      get: jasmine.createSpy().and.returnValue(of(invitation)),
      patch: jasmine.createSpy().and.returnValue(of({ ...invitation, type: 'Video', status: 'Active' })),
    };
    TestBed.configureTestingModule({ providers: [
      CallsService,
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me' }, device: { id: 'shared-device' } }) } },
      { provide: NivraApiService, useValue: api },
      { provide: Router, useValue: { navigateByUrl: jasmine.createSpy() } },
      { provide: ChatService, useValue: { conversations: signal([]) } },
      { provide: CryptoService, useValue: {} },
      { provide: LocalHistoryService, useValue: { accountKeysForUser: async () => [], calls: async () => [], putCalls: async () => undefined } },
      { provide: NativeDeviceService, useValue: {
        onNativeCallAction: () => Promise.resolve(null), clearIncomingCall: () => Promise.resolve(),
        showIncomingCall: () => Promise.resolve(),
        setActiveCall: () => Promise.resolve(false),
      } },
      { provide: SignalrService, useValue: { events$: new Subject() } },
      { provide: CallAudioOutputService, useValue: { sync: jasmine.createSpy(), resume: jasmine.createSpy().and.resolveTo(), playbackBlocked: signal(false) } },
      { provide: CallGameSessionService, useValue: { configure: jasmine.createSpy(), reset: jasmine.createSpy(), transport: { detachPeer: jasmine.createSpy(), attachDirect: jasmine.createSpy() } } },
      { provide: GroupCallCryptoService, useValue: { updateRoster: jasmine.createSpy().and.resolveTo(), clear: jasmine.createSpy(), isMediaKeySignal: () => false } },
      { provide: NativeScreenShareService, useValue: { stop: jasmine.createSpy().and.resolveTo(), supported: () => false } },
    ] });
    service = TestBed.inject(CallsService);
    spyOn<any>(service, 'addHistory');
    spyOn<any>(service, 'startRingingTone');
    spyOn<any>(service, 'scheduleRingTimeout');
  });

  afterEach(() => service.ngOnDestroy());

  for (const requesterId of ['me', 'peer']) {
    it(`receives both cameras after ${requesterId} upgrades an established voice call in a real browser`, async () => {
      // Gather fresh host candidates for two endpoints sharing one browser
      // and network interface. The production pool=4 case is covered
      // separately by the real-connection configuration regression above.
      const NativePeerConnection = window.RTCPeerConnection;
      spyOn(window, 'RTCPeerConnection').and.callFake(function (configuration?: RTCConfiguration) {
        return new NativePeerConnection({ ...configuration, iceCandidatePoolSize: 0 });
      });
      const other = TestBed.runInInjectionContext(() => new CallsService());
      const endpoints: Record<string, CallsService> = { me: service, peer: other };
      const failures: string[] = [];
      const audioSources: Array<{ track: MediaStreamTrack; writer: WritableStreamDefaultWriter<AudioData>; timer: number }> = [];
      const captures: MediaStream[] = [];
      const call = { ...invitation, status: 'Active' };
      let establishingBaseline = true;
      let sequence = 0;
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const painter = window.setInterval(() => {
        const context = canvas.getContext('2d')!;
        context.fillStyle = sequence++ % 2 ? '#005e50' : '#7becc9';
        context.fillRect(0, 0, 32, 32);
      }, 40);
      const until = async (label: string, check: () => boolean) => {
        const deadline = Date.now() + 6_000;
        while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (!check()) {
          throw new Error(label + ' ' + JSON.stringify({ failures,
            states: Object.entries(endpoints).map(([id, endpoint]) => ({
              id, phase: endpoint.phase(), error: endpoint.error(),
              tracks: Object.values(endpoint.remoteStreams()).flatMap(stream => stream.getTracks()
                .map(track => ({ kind: track.kind, muted: track.muted }))),
              peers: [...(endpoint as any).peers.values()].map(peer => ({
                state: peer.connection.connectionState, ice: peer.connection.iceConnectionState,
                signal: peer.connection.signalingState,
                transceivers: peer.connection.getTransceivers().map((item: RTCRtpTransceiver) => ({
                  kind: item.receiver.track.kind, direction: item.direction, currentDirection: item.currentDirection,
                  dtls: item.sender.transport?.state,
                })),
              })),
            })),
          }));
        }
      };
      try {
        for (const [userId, endpoint] of Object.entries(endpoints)) {
          if (endpoint === other) {
            spyOn<any>(endpoint, 'addHistory');
            spyOn<any>(endpoint, 'startRingingTone');
          }
          spyOn<any>(endpoint, 'currentUserId').and.returnValue(userId);
          spyOn<any>(endpoint, 'startSignalPolling');
          spyOn<any>(endpoint, 'loadIceConfiguration').and.resolveTo();
          spyOn<any>(endpoint, 'scheduleConnectedUiReconcile');
          spyOn<any>(endpoint, 'scheduleConnectionWatchdog');
          spyOn<any>(endpoint, 'decodeCallSignalPayload').and.callFake(async (event: any) => JSON.parse(event.payloadCiphertext));
          spyOn<any>(endpoint, 'sendCallSignal').and.callFake(async (current: CallSession, target: string, type: string, payload: unknown) => {
            if (establishingBaseline && type === 'ice') return;
            if (establishingBaseline && ['offer', 'answer'].includes(type)) {
              const connection = (endpoint as any).peers.get(target).connection as RTCPeerConnection;
              await until('baseline ICE gathering', () => connection.iceGatheringState === 'complete');
              payload = { description: connection.localDescription?.toJSON() };
            }
            // Delivery is asynchronous like SignalR; a POST does not wait for the peer's SDP answer.
            window.setTimeout(() => {
              void (endpoints[target] as any).handleCallSignal({
                callId: current.id, fromUserId: userId, signalType: type,
                signalId: String(sequence++), payloadCiphertext: JSON.stringify({ payload }),
              }).catch((error: unknown) => failures.push(String(error)));
            }, 0);
          });
          endpoint.activeCall.set(call);
          endpoint.phase.set('connecting');
          (endpoint as any).iceServers = [];
          // Feed microphone samples directly. Web Audio can remain suspended
          // until a user gesture, so it is unsuitable for a headless RTP test.
          const Generator = (window as unknown as {
            MediaStreamTrackGenerator: new (options: { kind: string }) => MediaStreamTrack & { writable: WritableStream<AudioData> };
          }).MediaStreamTrackGenerator;
          const audio = new Generator({ kind: 'audio' });
          const writer = audio.writable.getWriter();
          let timestamp = 0;
          const timer = window.setInterval(() => {
            const sample = new AudioData({ format: 'f32', sampleRate: 48_000, numberOfFrames: 960, numberOfChannels: 1,
              timestamp, data: new Float32Array(960) });
            timestamp += 20_000;
            void writer.write(sample).finally(() => sample.close()).catch(() => undefined);
          }, 20);
          audioSources.push({ track: audio, writer, timer });
          endpoint.localStream.set(new MediaStream([audio]));
          spyOn<any>(endpoint, 'restoreDirectMediaTrack').and.callFake(async () => {
            const capture = canvas.captureStream(20);
            captures.push(capture);
            const stream = new MediaStream([...(endpoint.localStream()?.getAudioTracks() ?? []), ...capture.getVideoTracks()]);
            endpoint.localStream.set(stream);
            for (const peer of (endpoint as any).peers.values()) {
              await (endpoint as any).setOutgoingTrack(peer.connection, 'video', capture.getVideoTracks()[0], stream);
            }
          });
        }
        // This test starts from an established voice call. Do not race the
        // explicit baseline SDP exchange against initial negotiationneeded
        // events from adding the synthetic microphone on both new peers.
        const baseline = Object.entries(endpoints).map(([userId, endpoint]) => {
          const connection = (endpoint as any).ensurePeerConnection(userId === 'me' ? 'peer' : 'me') as RTCPeerConnection;
          const negotiation = connection.onnegotiationneeded;
          connection.onnegotiationneeded = null;
          return { connection, negotiation };
        });
        await (service as any).createAndSendOffer('peer');
        await until('audio connected', () => baseline.every(peer => peer.connection.connectionState === 'connected'));
        establishingBaseline = false;
        baseline.forEach(peer => { peer.connection.onnegotiationneeded = peer.negotiation; });
        const requester = endpoints[requesterId];
        const receiver = endpoints[requesterId === 'me' ? 'peer' : 'me'];
        await requester.enableVideo();
        await until('receiver invitation', () => receiver.mediaUpgradeRequested());
        await receiver.acceptVideoUpgrade();
        await until('both videos receiving frames', () => Object.entries(endpoints).every(([userId, endpoint]) =>
          endpoint.remoteStreams()[userId === 'me' ? 'peer' : 'me']?.getVideoTracks()
            .some(track => track.readyState === 'live' && !track.muted)));
        expect(failures).toEqual([]);
        expect(service.error()).toBe('');
        expect(other.error()).toBe('');
      } finally {
        window.clearInterval(painter);
        captures.forEach(stream => stream.getTracks().forEach(track => track.stop()));
        other.ngOnDestroy();
        service.releaseLocalResources();
        for (const source of audioSources) {
          window.clearInterval(source.timer);
          source.track.stop();
          await source.writer.abort().catch(() => undefined);
        }
      }
    }, 20_000);
  }

});
