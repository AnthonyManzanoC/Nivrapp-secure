package com.nivra.app;

import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjection;
import android.util.DisplayMetrics;
import org.webrtc.*;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

/** Screen frames remain on native video surfaces and travel over a local DTLS/SRTP peer. */
final class NivraScreenShareSession {
    private final Context context;
    private final String sessionId;
    private final Runnable requestStop;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final AtomicBoolean closed = new AtomicBoolean();
    private boolean answered;
    private EglBase egl;
    private PeerConnectionFactory factory;
    private PeerConnection peer;
    private ScreenCapturerAndroid capturer;
    private SurfaceTextureHelper texture;
    private VideoSource source;
    private VideoTrack track;

    NivraScreenShareSession(Context context, String sessionId, Runnable requestStop) {
        this.context = context;
        this.sessionId = sessionId;
        this.requestStop = requestStop;
    }

    void start(Intent permissionData, String offer) {
        run(() -> {
            try {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions());
                egl = EglBase.create();
                factory = PeerConnectionFactory.builder()
                    .setVideoEncoderFactory(new DefaultVideoEncoderFactory(egl.getEglBaseContext(), true, true))
                    .setVideoDecoderFactory(new DefaultVideoDecoderFactory(egl.getEglBaseContext())).createPeerConnectionFactory();
                PeerConnection.RTCConfiguration config = new PeerConnection.RTCConfiguration(Collections.emptyList());
                config.sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN;
                peer = factory.createPeerConnection(config, observer());
                if (peer == null) throw new IllegalStateException("Local screen peer unavailable");
                source = factory.createVideoSource(true);
                texture = SurfaceTextureHelper.create("NivraScreenCapture", egl.getEglBaseContext());
                capturer = new ScreenCapturerAndroid(permissionData, new MediaProjection.Callback() {
                    @Override public void onStop() { fail("system_stopped"); }
                    @Override public void onCapturedContentResize(int width, int height) {
                        run(() -> resize(width, height));
                    }
                });
                capturer.initialize(texture, context, source.getCapturerObserver());
                DisplayMetrics metrics = context.getResources().getDisplayMetrics();
                int[] size = captureSize(metrics.widthPixels, metrics.heightPixels);
                capturer.startCapture(size[0], size[1], 15);
                track = factory.createVideoTrack("nivra-screen", source);
                peer.addTrack(track, Collections.singletonList("nivra-screen-stream"));
                peer.setRemoteDescription(new SdpAdapter() {
                    @Override public void onSetSuccess() {
                        run(() -> peer.createAnswer(new SdpAdapter() {
                            @Override public void onCreateSuccess(SessionDescription answer) {
                                run(() -> peer.setLocalDescription(new SdpAdapter() {
                                    @Override public void onSetSuccess() { run(() -> publishAnswer()); }
                                }, answer));
                            }
                        }, new MediaConstraints()));
                    }
                }, new SessionDescription(SessionDescription.Type.OFFER, offer));
            } catch (RuntimeException error) {
                fail("capture_failed");
            }
        });
    }

    private PeerConnection.Observer observer() {
        return new PeerConnection.Observer() {
            @Override public void onSignalingChange(PeerConnection.SignalingState state) {}
            @Override public void onIceConnectionChange(PeerConnection.IceConnectionState state) {
                if (state == PeerConnection.IceConnectionState.FAILED) fail("connection_failed");
            }
            @Override public void onIceConnectionReceivingChange(boolean receiving) {}
            @Override public void onIceGatheringChange(PeerConnection.IceGatheringState state) {
                if (state == PeerConnection.IceGatheringState.COMPLETE) run(() -> publishAnswer());
            }
            @Override public void onIceCandidate(IceCandidate candidate) {}
            @Override public void onIceCandidatesRemoved(IceCandidate[] candidates) {}
            @Override public void onAddStream(MediaStream stream) {}
            @Override public void onRemoveStream(MediaStream stream) {}
            @Override public void onDataChannel(DataChannel channel) { channel.close(); }
            @Override public void onRenegotiationNeeded() {}
            @Override public void onAddTrack(RtpReceiver receiver, MediaStream[] streams) {}
        };
    }

    private void publishAnswer() {
        if (answered || peer == null || peer.iceGatheringState() != PeerConnection.IceGatheringState.COMPLETE) return;
        SessionDescription answer = peer.getLocalDescription();
        if (answer == null) return;
        answered = true;
        NivraScreenSharePlugin.answerReady(sessionId, answer.description);
    }

    private void resize(int width, int height) {
        if (capturer == null || width <= 0 || height <= 0) return;
        int[] size = captureSize(width, height);
        capturer.changeCaptureFormat(size[0], size[1], 15);
    }

    private static int[] captureSize(int width, int height) {
        double scale = Math.min(1d, 1280d / Math.max(1, Math.max(width, height)));
        return new int[] { Math.max(2, ((int) (width * scale) / 2) * 2), Math.max(2, ((int) (height * scale) / 2) * 2) };
    }

    private void run(Runnable task) {
        if (closed.get()) return;
        try { worker.execute(() -> { if (!closed.get()) task.run(); }); }
        catch (RejectedExecutionException ignored) {}
    }

    private void fail(String reason) {
        if (closed.get()) return;
        NivraScreenSharePlugin.sessionEnded(sessionId, reason);
        requestStop.run();
    }

    void stop() {
        if (!closed.compareAndSet(false, true)) return;
        worker.execute(() -> {
            if (capturer != null) {
                capturer.stopCapture();
                capturer.dispose();
            }
            if (peer != null) { peer.close(); peer.dispose(); }
            if (track != null) track.dispose();
            if (source != null) source.dispose();
            if (texture != null) texture.dispose();
            if (factory != null) factory.dispose();
            if (egl != null) egl.release();
        });
        worker.shutdown();
    }

    private class SdpAdapter implements SdpObserver {
        @Override public void onCreateSuccess(SessionDescription description) {}
        @Override public void onSetSuccess() {}
        @Override public void onCreateFailure(String message) { fail("negotiation_failed"); }
        @Override public void onSetFailure(String message) { fail("negotiation_failed"); }
    }
}
