package com.nivra.app;

import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import android.speech.RecognitionListener;
import android.speech.RecognitionSupport;
import android.speech.RecognitionSupportCallback;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.common.model.DownloadConditions;
import com.google.mlkit.nl.translate.TranslateLanguage;
import com.google.mlkit.nl.translate.Translation;
import com.google.mlkit.nl.translate.Translator;
import com.google.mlkit.nl.translate.TranslatorOptions;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Optional local call captions, fed only with the already received remote PCM.
 * No microphone capture, file recording, normal/cloud recognizer or audio routing
 * is performed here. Provider/support errors stop this optional feature. The
 * platform's optional injected-audio extras require a compatible local engine.
 */
@CapacitorPlugin(name = "CallTranslation")
public class CallTranslationPlugin extends Plugin {
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LinkedHashMap<String, Long> cancelled = new LinkedHashMap<>();
    private volatile Session current;
    private volatile boolean destroyed;
    private boolean foreground = true;

    private static final class Session {
        final String id;
        final String source;
        final String target;
        final boolean voice;
        final AtomicBoolean closed = new AtomicBoolean();
        final ArrayBlockingQueue<byte[]> audio = new ArrayBlockingQueue<>(CallTranslationPolicy.AUDIO_QUEUE_BLOCKS);
        final ArrayDeque<String> text = new ArrayDeque<>();
        PluginCall pending;
        ParcelFileDescriptor read;
        ParcelFileDescriptor write;
        SpeechRecognizer recognizer;
        Translator translator;
        TextToSpeech tts;
        ExecutorService writer;
        Intent intent;
        Runnable timeout;
        volatile boolean ready;
        boolean translating;
        String lastPartial = "";
        long lastPartialAt;
        long utterance;

        Session(String id, String source, String target, boolean voice, PluginCall call) {
            this.id = id; this.source = source; this.target = target; this.voice = voice; this.pending = call;
        }
    }

    @PluginMethod public void start(PluginCall call) {
        final String id = call.getString("sessionId");
        final String source = call.getString("sourceLanguage");
        final String target = call.getString("targetLanguage");
        final boolean voice = Boolean.TRUE.equals(call.getBoolean("voice", false));
        if (!CallTranslationPolicy.validSessionId(id) || CallTranslationPolicy.language(source).isEmpty()
            || CallTranslationPolicy.language(target).isEmpty()) {
            call.reject("Elige los idiomas de la llamada y vuelve a iniciar la traducción.", "TRANSLATION_INVALID");
            return;
        }
        main.post(() -> begin(call, id, source, target, voice));
    }

    @PluginMethod public void feedPcm(PluginCall call) {
        String id = call.getString("sessionId");
        String encoded = call.getString("base64");
        Session session = current;
        if (!isCurrent(session) || !session.id.equals(id) || !session.ready) {
            call.reject("La traducción ya no está activa.", "TRANSLATION_INACTIVE"); return;
        }
        if (encoded == null || encoded.length() > CallTranslationPolicy.MAX_BASE64_CHARS) {
            call.reject("Fragmento de audio inválido.", "TRANSLATION_PCM_INVALID"); return;
        }
        byte[] bytes;
        try { bytes = Base64.decode(encoded, Base64.NO_WRAP); }
        catch (IllegalArgumentException error) {
            call.reject("Fragmento de audio inválido.", "TRANSLATION_PCM_INVALID"); return;
        }
        if (!CallTranslationPolicy.validPcmLength(bytes.length)) {
            Arrays.fill(bytes, (byte) 0);
            call.reject("Fragmento de audio inválido.", "TRANSLATION_PCM_INVALID"); return;
        }
        if (!session.audio.offer(bytes)) {
            Arrays.fill(bytes, (byte) 0);
            main.post(() -> fail(session, "El motor local no alcanza a procesar el audio. La llamada continúa sin traducción."));
            call.reject("El motor local está ocupado.", "TRANSLATION_BACKPRESSURE"); return;
        }
        if (!isCurrent(session)) {
            session.audio.remove(bytes); Arrays.fill(bytes, (byte) 0);
            call.reject("La traducción se detuvo.", "TRANSLATION_INACTIVE"); return;
        }
        call.resolve();
    }

    @PluginMethod public void stop(PluginCall call) {
        String id = call.getString("sessionId");
        main.post(() -> {
            if (CallTranslationPolicy.validSessionId(id)) rememberCancellation(id);
            Session session = current;
            if (session != null && session.id.equals(id)) close(session, "Traducción detenida.");
            call.resolve();
        });
    }

    private void begin(PluginCall call, String id, String source, String target, boolean voice) {
        if (destroyed || !foreground || getActivity() == null || getActivity().isFinishing() || getActivity().isDestroyed()
            || getBridge() == null || getBridge().getWebView() == null
            || !LauncherAppearancePolicy.trustedDocument(getBridge().getWebView().getUrl())) {
            call.reject("La traducción requiere la app abierta durante la llamada.", "TRANSLATION_UNAVAILABLE"); return;
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            call.reject("La traducción local de llamadas requiere Android 13 o posterior.", "TRANSLATION_UNAVAILABLE"); return;
        }
        pruneCancellations();
        if (cancelled.containsKey(id)) { call.reject("Traducción cancelada.", "TRANSLATION_CANCELLED"); return; }
        String from = TranslateLanguage.fromLanguageTag(source);
        String to = TranslateLanguage.fromLanguageTag(target);
        if (from == null || to == null || from.equals(to)) {
            call.reject("Elige dos idiomas distintos compatibles con la traducción local.", "TRANSLATION_LANGUAGE"); return;
        }
        Session old = current;
        if (old != null) { rememberCancellation(old.id); close(old, "Se inició otra sesión de traducción."); }
        Session session = new Session(id, source, target, voice, call);
        current = session;
        session.timeout = () -> fail(session, "No se pudieron preparar los modelos locales. Comprueba el motor de voz y descarga los idiomas con Wi-Fi.");
        main.postDelayed(session.timeout, 120_000);
        try {
            if (!SpeechRecognizer.isOnDeviceRecognitionAvailable(getContext())) {
                fail(session, "Este teléfono no dispone de un motor de reconocimiento de voz local compatible."); return;
            }
            ParcelFileDescriptor[] pipe = ParcelFileDescriptor.createPipe();
            session.read = pipe[0]; session.write = pipe[1];
            int flags = Os.fcntlInt(session.write.getFileDescriptor(), OsConstants.F_GETFL, 0);
            Os.fcntlInt(session.write.getFileDescriptor(), OsConstants.F_SETFL, flags | OsConstants.O_NONBLOCK);
            session.recognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(getContext());
            session.recognizer.setRecognitionListener(listener(session));
            session.intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, source)
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, session.read)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
                .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, 16000)
                .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE);
            // No legacy fallback: providers unable to check this exact injected
            // audio request are rejected before startListening is called.
            session.recognizer.checkRecognitionSupport(session.intent, getContext().getMainExecutor(), new RecognitionSupportCallback() {
                @Override public void onSupportResult(RecognitionSupport support) {
                    if (!isCurrent(session)) return;
                    String installed = CallTranslationPolicy.installedLanguage(source, support.getInstalledOnDeviceLanguages());
                    if (installed.isEmpty()) {
                        fail(session, "Falta el idioma de voz local seleccionado. Instálalo en el reconocimiento de voz del teléfono y vuelve a intentarlo."); return;
                    }
                    session.intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, installed);
                    if (voice) prepareVoice(session, from, to); else prepareTranslator(session, from, to);
                }
                @Override public void onError(int error) {
                    fail(session, "El motor local no confirmó que admita el audio de esta llamada. La llamada continúa sin traducción.");
                }
            });
        } catch (Exception error) {
            fail(session, "No se pudo preparar el reconocimiento local de la llamada.");
        }
    }

    private void prepareVoice(Session session, String from, String to) {
        if (!isCurrent(session)) return;
        try {
            session.tts = new TextToSpeech(getContext(), status -> main.post(() -> {
                if (!isCurrent(session)) return;
                try {
                if (status != TextToSpeech.SUCCESS || session.tts == null) {
                    fail(session, "No hay una voz local disponible. Puedes usar sólo subtítulos."); return;
                }
                Voice chosen = null;
                Set<Voice> voices = session.tts.getVoices();
                if (voices != null) for (Voice candidate : voices) {
                    Set<String> features = candidate.getFeatures();
                    if (candidate.isNetworkConnectionRequired() || candidate.getLocale() == null
                        || !to.equals(candidate.getLocale().getLanguage())
                        || (features != null && features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED))) continue;
                    if (chosen == null || candidate.getQuality() > chosen.getQuality()) chosen = candidate;
                }
                if (chosen == null || session.tts.setVoice(chosen) != TextToSpeech.SUCCESS) {
                    fail(session, "Instala una voz sin conexión para el idioma de destino o utiliza sólo subtítulos."); return;
                }
                session.tts.setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build());
                session.tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) { }
                    @Override public void onDone(String utteranceId) { }
                    @Override public void onError(String utteranceId) {
                        main.post(() -> fail(session, "La voz local no pudo reproducirse. La llamada continúa sin traducción."));
                    }
                });
                prepareTranslator(session, from, to);
                } catch (RuntimeException error) {
                    fail(session, "No se pudo preparar una voz sin conexión. Puedes usar sólo subtítulos.");
                }
            }));
        } catch (RuntimeException error) { fail(session, "No se pudo abrir una voz local. Puedes usar sólo subtítulos."); }
    }

    private void prepareTranslator(Session session, String from, String to) {
        if (!isCurrent(session)) return;
        try {
            session.translator = Translation.getClient(new TranslatorOptions.Builder().setSourceLanguage(from).setTargetLanguage(to).build());
            // The explicit start action explains model downloads. No text/audio
            // is uploaded; absent translation models download only over Wi-Fi.
            session.translator.downloadModelIfNeeded(new DownloadConditions.Builder().requireWifi().build())
                .addOnSuccessListener(unused -> { if (isCurrent(session)) startRecognizer(session); })
                .addOnFailureListener(error -> fail(session, "No se pudieron descargar los idiomas de traducción. Conéctate a Wi-Fi y vuelve a intentarlo."));
        } catch (RuntimeException error) { fail(session, "No se pudo preparar la traducción local de estos idiomas."); }
    }

    private void startRecognizer(Session session) {
        if (!isCurrent(session)) return;
        try {
            session.writer = Executors.newSingleThreadExecutor(runnable -> new Thread(runnable, "nivra-call-translation-pcm"));
            session.writer.execute(() -> writeAudio(session));
            session.recognizer.startListening(session.intent);
            if (!isCurrent(session)) return;
            session.ready = true;
            main.removeCallbacks(session.timeout);
            PluginCall pending = session.pending; session.pending = null;
            if (pending != null) pending.resolve();
        } catch (RuntimeException error) { fail(session, "El motor local no pudo iniciar los subtítulos de la llamada."); }
    }

    private void writeAudio(Session session) {
        byte[] bytes = null;
        try {
            while (isCurrent(session)) {
                bytes = session.audio.poll(250, TimeUnit.MILLISECONDS);
                if (bytes == null) continue;
                int offset = 0;
                long deadline = SystemClock.elapsedRealtime() + 1500;
                while (offset < bytes.length && isCurrent(session)) {
                    try { offset += Os.write(session.write.getFileDescriptor(), bytes, offset, bytes.length - offset); }
                    catch (ErrnoException error) {
                        if (error.errno != OsConstants.EAGAIN) throw error;
                        if (SystemClock.elapsedRealtime() >= deadline) throw new IOException("Local recognizer is not consuming PCM");
                        Thread.sleep(8);
                    }
                }
                Arrays.fill(bytes, (byte) 0); bytes = null;
            }
        } catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        catch (Exception error) {
            main.post(() -> fail(session, "El motor local dejó de procesar el audio. La llamada continúa sin traducción."));
        } finally { if (bytes != null) Arrays.fill(bytes, (byte) 0); }
    }

    private RecognitionListener listener(Session session) {
        return new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) { }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float rmsdB) { }
            @Override public void onBufferReceived(byte[] buffer) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onError(int error) {
                String message = error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                    ? "El idioma de voz no está disponible sin conexión en este teléfono."
                    : "El reconocimiento local no pudo continuar. La llamada sigue sin traducción.";
                fail(session, message);
            }
            @Override public void onPartialResults(Bundle results) { recognised(session, results, false); }
            @Override public void onResults(Bundle results) { recognised(session, results, true); }
            @Override public void onSegmentResults(Bundle results) { recognised(session, results, true); }
            @Override public void onEndOfSegmentedSession() {
                fail(session, "El motor local finalizó los subtítulos. Puedes volver a iniciarlos; la llamada continúa.");
            }
            @Override public void onEvent(int eventType, Bundle params) { }
        };
    }

    private void recognised(Session session, Bundle results, boolean finalResult) {
        if (!isCurrent(session) || results == null) return;
        ArrayList<String> candidates = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        String original = candidates == null || candidates.isEmpty() || candidates.get(0) == null ? "" : candidates.get(0).trim();
        if (original.isEmpty()) return;
        if (original.length() > CallTranslationPolicy.MAX_TEXT_CHARS) {
            fail(session, "El segmento de voz supera el límite local. Vuelve a iniciar los subtítulos."); return;
        }
        if (!finalResult) {
            long now = SystemClock.elapsedRealtime();
            if (original.equals(session.lastPartial) || now - session.lastPartialAt < 250) return;
            session.lastPartial = original; session.lastPartialAt = now;
            caption(session, original, "", false); return;
        }
        session.lastPartial = "";
        if (session.text.size() >= CallTranslationPolicy.MAX_TEXT_QUEUE) {
            fail(session, "La traducción local no alcanza el ritmo de la conversación. La llamada continúa sin traducción."); return;
        }
        session.text.offer(original);
        translateNext(session);
    }

    private void translateNext(Session session) {
        if (!isCurrent(session) || session.translating || session.text.isEmpty()) return;
        String original = session.text.poll();
        session.translating = true;
        try {
        session.translator.translate(original).addOnSuccessListener(translated -> {
            if (!isCurrent(session)) return;
            session.translating = false;
            caption(session, original, translated, true);
            if (session.voice && session.tts != null) {
                // Keep speech bounded to the newest completed segment. Neither
                // audio focus nor the call's routing/mode is changed here.
                try {
                    Voice selected = session.tts.getVoice();
                    if (selected == null || selected.isNetworkConnectionRequired()) {
                        fail(session, "La voz sin conexión ya no está disponible. La llamada continúa sin traducción."); return;
                    }
                    int result = session.tts.speak(translated, TextToSpeech.QUEUE_FLUSH, null, session.id + ":" + ++session.utterance);
                    if (result == TextToSpeech.ERROR) { fail(session, "No se pudo reproducir la traducción con la voz local."); return; }
                } catch (RuntimeException error) {
                    fail(session, "No se pudo reproducir la traducción con la voz local."); return;
                }
            }
            translateNext(session);
        }).addOnFailureListener(error -> fail(session, "No se pudo traducir el segmento con los modelos locales. La llamada continúa."));
        } catch (RuntimeException error) {
            fail(session, "El traductor local no pudo procesar el segmento. La llamada continúa.");
        }
    }

    private void caption(Session session, String original, String text, boolean finalResult) {
        if (!isCurrent(session)) return;
        JSObject event = new JSObject(); event.put("sessionId", session.id); event.put("original", original);
        event.put("text", text); event.put("final", finalResult);
        notifyListeners("caption", event);
    }

    private boolean isCurrent(Session session) {
        return session != null && current == session && !session.closed.get() && !destroyed;
    }

    private void fail(Session session, String message) {
        if (!isCurrent(session)) return;
        JSObject event = new JSObject(); event.put("sessionId", session.id); event.put("message", message);
        notifyListeners("failure", event);
        rememberCancellation(session.id);
        close(session, message);
    }

    private void close(Session session, String message) {
        if (session == null || !session.closed.compareAndSet(false, true)) return;
        if (current == session) current = null;
        session.ready = false;
        if (session.timeout != null) main.removeCallbacks(session.timeout);
        byte[] queued;
        while ((queued = session.audio.poll()) != null) Arrays.fill(queued, (byte) 0);
        session.text.clear(); session.lastPartial = "";
        closePipe(session.write); closePipe(session.read);
        if (session.writer != null) session.writer.shutdownNow();
        if (session.recognizer != null) {
            try { session.recognizer.cancel(); } catch (RuntimeException ignored) { }
            try { session.recognizer.destroy(); } catch (RuntimeException ignored) { }
        }
        if (session.translator != null) {
            try { session.translator.close(); } catch (RuntimeException ignored) { }
        }
        if (session.tts != null) {
            try { session.tts.stop(); } catch (RuntimeException ignored) { }
            try { session.tts.shutdown(); } catch (RuntimeException ignored) { }
        }
        PluginCall pending = session.pending; session.pending = null;
        if (pending != null) pending.reject(message, "TRANSLATION_STOPPED");
    }

    private void closePipe(ParcelFileDescriptor descriptor) {
        if (descriptor == null) return;
        try { descriptor.close(); } catch (IOException ignored) { }
    }

    private void rememberCancellation(String id) {
        cancelled.put(id, SystemClock.elapsedRealtime()); pruneCancellations();
    }

    private void pruneCancellations() {
        long oldest = SystemClock.elapsedRealtime() - 600_000;
        Iterator<Map.Entry<String, Long>> iterator = cancelled.entrySet().iterator();
        while (iterator.hasNext()) {
            Map.Entry<String, Long> value = iterator.next();
            if (value.getValue() < oldest || cancelled.size() > 16) iterator.remove();
        }
    }

    @Override protected void handleOnResume() { main.post(() -> foreground = true); }
    @Override protected void handleOnPause() {
        main.post(() -> { foreground = false; Session session = current;
            if (session != null) fail(session, "La traducción se detuvo al salir de la app. La llamada continúa."); });
    }
    @Override protected void handleOnDestroy() {
        destroyed = true;
        main.post(() -> { Session session = current;
            if (session != null) close(session, "Traducción detenida."); cancelled.clear(); });
    }
}
