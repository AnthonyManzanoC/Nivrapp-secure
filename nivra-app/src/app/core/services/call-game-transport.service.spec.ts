import { CallGameTransportService } from './call-game-transport.service';

describe('call game transport over real WebRTC', () => {
  let alice: CallGameTransportService;
  let bob: CallGameTransportService;
  let a: RTCPeerConnection;
  let b: RTCPeerConnection;
  let video: MediaStreamTrack;
  const waitFor = async (condition: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    if (!condition()) throw new Error('RTC fixture did not connect');
  };
  beforeEach(async () => {
    alice = new CallGameTransportService(); bob = new CallGameTransportService();
    a = new RTCPeerConnection({ iceServers: [] }); b = new RTCPeerConnection({ iceServers: [] });
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    canvas.getContext('2d')!.fillRect(0, 0, 32, 32);
    video = canvas.captureStream(1).getVideoTracks()[0];
    a.addTrack(video);
    alice.configure('call-one', ['bob']); bob.configure('call-one', ['alice']);
    alice.attachDirect('bob', a, true); bob.attachDirect('alice', b, false);
    await a.setLocalDescription(await a.createOffer());
    await waitFor(() => a.iceGatheringState === 'complete');
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await waitFor(() => b.iceGatheringState === 'complete');
    await a.setRemoteDescription(b.localDescription!);
    await waitFor(() => alice.connectedPeers().length === 1 && bob.connectedPeers().length === 1);
  });
  afterEach(() => { alice.reset(); bob.reset(); a.close(); b.close(); video?.stop(); });

  it('delivers JSON in both directions while retaining the video sender', async () => {
    const received: unknown[] = [];
    bob.packets$.subscribe(packet => received.push(packet));
    alice.packets$.subscribe(packet => received.push(packet));
    await alice.send({ action: 'move', x: 1, y: 2 });
    await bob.send({ action: 'joined' });
    await waitFor(() => received.length === 2);
    expect(received).toContain(jasmine.objectContaining({ senderUserId: 'alice', body: { action: 'move', x: 1, y: 2 } }));
    expect(a.getSenders().find(sender => sender.track === video)).toBeDefined();
    expect(video.readyState).toBe('live');
  });

  it('rejects oversized packets and packets from a previous call', async () => {
    await expectAsync(alice.send({ message: 'x'.repeat(13000) })).toBeRejected();
    const receive = jasmine.createSpy(); bob.packets$.subscribe(receive);
    bob.configure('other-call', ['alice']);
    (bob as any).receive('alice', new TextEncoder().encode(JSON.stringify({ v: 1, callId: 'call-one', body: { action: 'move' } })));
    expect(receive).not.toHaveBeenCalled();
  });

  it('closes game channels independently of captured media', () => {
    alice.reset();
    expect(alice.connectedPeers()).toEqual([]);
    expect(video.readyState).toBe('live');
  });
});
