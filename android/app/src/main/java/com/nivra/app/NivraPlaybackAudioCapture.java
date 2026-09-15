package com.nivra.app;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioPlaybackCaptureConfiguration;
import android.media.AudioRecord;
import android.media.projection.MediaProjection;
import android.os.Build;
import android.os.Process;
import java.nio.ByteBuffer;

/** Audio explicitly permitted by the source app and Android's projection grant.
 * Never opens the microphone and excludes our own call playback to prevent echo.
 */
final class NivraPlaybackAudioCapture {
    private AudioRecord recorder;

    synchronized boolean start(MediaProjection projection) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || projection == null) return false;
        try {
            AudioPlaybackCaptureConfiguration capture = new AudioPlaybackCaptureConfiguration.Builder(projection)
                .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
                .addMatchingUsage(AudioAttributes.USAGE_GAME)
                .addMatchingUsage(AudioAttributes.USAGE_UNKNOWN)
                .excludeUid(Process.myUid()).build();
            AudioFormat format = new AudioFormat.Builder().setSampleRate(48000)
                .setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_IN_MONO).build();
            int minimum = AudioRecord.getMinBufferSize(48000, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            recorder = new AudioRecord.Builder().setAudioFormat(format)
                .setBufferSizeInBytes(Math.max(9600, minimum))
                .setAudioPlaybackCaptureConfig(capture).build();
            if (recorder.getState() != AudioRecord.STATE_INITIALIZED) { stop(); return false; }
            recorder.startRecording();
            if (recorder.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) { stop(); return false; }
            return true;
        } catch (RuntimeException unavailable) { stop(); return false; }
    }

    // Called on WebRTC's paced 10 ms audio thread. A nonblocking read keeps
    // call media responsive if Android/source policy temporarily returns silence.
    synchronized long fill(ByteBuffer buffer, int format, int channels, int sampleRate, int bytes, long timestamp) {
        buffer.clear();
        for (int i = 0; i < buffer.capacity(); i++) buffer.put(i, (byte) 0);
        if (recorder != null && format == AudioFormat.ENCODING_PCM_16BIT && channels == 1 && sampleRate == 48000) {
            try { recorder.read(buffer, buffer.capacity(), AudioRecord.READ_NON_BLOCKING); }
            catch (RuntimeException revoked) { stop(); }
        }
        buffer.rewind();
        return timestamp;
    }

    synchronized void stop() {
        if (recorder == null) return;
        try { recorder.stop(); } catch (RuntimeException ignored) { }
        recorder.release();
        recorder = null;
    }
}
