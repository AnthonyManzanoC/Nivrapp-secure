import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { of, Subject, throwError } from 'rxjs';
import { CallsService } from './calls.service';
import { AuthService } from './auth.service';
import { CallAudioOutputService } from './call-audio-output.service';
import { ChatService } from './chat.service';
import { CryptoService } from './crypto.service';
import { LocalHistoryService } from './local-history.service';
import { NativeDeviceService } from './native-device.service';
import { NivraApiService } from './nivra-api.service';
import { SignalrService } from './signalr.service';
import { CallSession } from '../models/nivra.models';

describe('call session isolation', () => {
  let service: CallsService;
  let api: { post: jasmine.Spy; get: jasmine.Spy };
  const invitation: CallSession = {
    id: 'incoming', initiatorUserId: 'peer', participantUserIds: ['me', 'peer'],
    type: 'Voice', status: 'Ringing', startedAt: new Date().toISOString(),
  };

  beforeEach(() => {
    api = { post: jasmine.createSpy().and.returnValue(of(invitation)), get: jasmine.createSpy().and.returnValue(of(invitation)) };
    TestBed.configureTestingModule({ providers: [
      CallsService,
      { provide: AuthService, useValue: { session: signal({ user: { id: 'me' }, device: { id: 'shared-device' } }) } },
      { provide: NivraApiService, useValue: api },
      { provide: Router, useValue: { navigateByUrl: jasmine.createSpy() } },
      { provide: ChatService, useValue: { conversations: signal([]) } },
      { provide: CryptoService, useValue: {} },
      { provide: LocalHistoryService, useValue: {} },
      { provide: NativeDeviceService, useValue: {
        onNativeCallAction: () => Promise.resolve(null), clearIncomingCall: () => Promise.resolve(),
        showIncomingCall: () => Promise.resolve(),
        setActiveCall: () => Promise.resolve(false),
      } },
      { provide: SignalrService, useValue: { events$: new Subject() } },
      { provide: CallAudioOutputService, useValue: { sync: jasmine.createSpy(), playbackBlocked: signal(false) } },
    ] });
    service = TestBed.inject(CallsService);
    spyOn<any>(service, 'addHistory');
    spyOn<any>(service, 'startRingingTone');
    spyOn<any>(service, 'scheduleRingTimeout');
  });

  afterEach(() => service.ngOnDestroy());

  it('does not open a second outgoing call from a broadcast to the same device', async () => {
    await (service as any).receiveIncoming({ ...invitation, initiatorUserId: 'me', initiatorDeviceId: 'shared-device' });
    expect(service.activeCall()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('closes a losing tab locally even when its device id matches', () => {
    service.activeCall.set(invitation);
    service.phase.set('connected');
    (service as any).handleAnsweredElsewhere({ callId: invitation.id, answeredByUserId: 'me',
      answeredByDeviceId: 'shared-device', answeredBySessionId: 'another-tab' });
    expect(service.activeCall()).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('never starts media after an answer ownership conflict', async () => {
    api.post.and.returnValue(throwError(() => ({ status: 409, error: { code: 'call_owned_elsewhere' } })));
    const media = spyOn<any>(service, 'prepareMedia');
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    await service.accept();
    expect(media).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
    expect(api.post.calls.count()).toBe(1);
    expect(api.post.calls.first().args[0]).toContain('/claim');
  });

  it('does not terminate a room when an unanswered device times out', async () => {
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    await (service as any).handleRingTimeout(invitation.id);
    expect(api.post).not.toHaveBeenCalled();
    expect(service.activeCall()).toBeNull();
  });

  it('defers incoming SDP until accepting without marking it consumed', async () => {
    service.activeCall.set(invitation);
    service.phase.set('ringing');
    const offer = { callId: invitation.id, fromUserId: 'peer', signalId: 'offer-1', signalType: 'offer' };
    await (service as any).handleCallSignal(offer);
    await (service as any).handleCallSignal(offer);
    expect((service as any).pendingSignals.length).toBe(1);
    expect((service as any).processedSignalIds.has('offer-1')).toBeFalse();
    const handle = spyOn<any>(service, 'handleWebRtcSignal').and.resolveTo();
    service.phase.set('connecting');
    await (service as any).flushPendingCallSignals();
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('ignores media signaling addressed to another tab', async () => {
    service.activeCall.set(invitation);
    service.phase.set('connecting');
    const handle = spyOn<any>(service, 'handleWebRtcSignal');
    await (service as any).handleCallSignal({ callId: invitation.id, fromUserId: 'peer', signalType: 'offer', targetClientSessionId: 'other-tab' });
    expect(handle).not.toHaveBeenCalled();
  });

  it('stops local resources immediately even if hanging up cannot reach the server', async () => {
    const response = new Subject<CallSession>();
    api.post.and.returnValue(response);
    service.activeCall.set(invitation);
    service.phase.set('connected');
    const ending = service.end();
    expect(service.activeCall()).toBeNull();
    response.error({ status: 0 });
    await ending;
    expect(service.phase()).toBe('idle');
    expect(service.error()).toContain('No se pudo confirmar');
  });

  it('keeps a just-answered call when the server refuses its late ring timeout', async () => {
    const outgoing = { ...invitation, initiatorUserId: 'me' };
    api.post.and.returnValue(of({ ...outgoing, status: 'Active' }));
    service.activeCall.set(outgoing);
    service.phase.set('calling');
    await (service as any).handleRingTimeout(invitation.id);
    expect(service.activeCall()?.id).toBe(invitation.id);
    expect(service.phase()).toBe('connecting');
    expect(api.post.calls.first().args[1].reason).toBe('timeout');
  });

  it('discards microphone permission results that arrive after hanging up', async () => {
    let grant!: (stream: MediaStream) => void;
    spyOn(navigator.mediaDevices, 'getUserMedia').and.returnValue(new Promise<MediaStream>((resolve) => { grant = resolve; }));
    const stop = jasmine.createSpy('stop');
    const capture = (service as any).prepareMedia(false) as Promise<MediaStream>;
    service.releaseLocalResources();
    grant({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await expectAsync(capture).toBeRejected();
    expect(stop).toHaveBeenCalled();
    expect(service.localStream()).toBeNull();
  });

  it('transfers a call only after the explicit continue-here action', async () => {
    service.resumableCall.set(invitation);
    expect(api.post).not.toHaveBeenCalled();
    const reconnect = spyOn(service, 'retryConnection').and.resolveTo();
    await service.resumeHere();
    expect(api.post.calls.first().args[0]).toBe('/calls/incoming/resume');
    expect(service.activeCall()?.id).toBe(invitation.id);
    expect(reconnect).toHaveBeenCalled();
  });
});
