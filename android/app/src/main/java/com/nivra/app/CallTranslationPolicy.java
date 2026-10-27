package com.nivra.app;

import java.util.List;
import java.util.Locale;

/** Bounds apply before decoding or queueing data supplied by the renderer. */
final class CallTranslationPolicy {
    static final int MAX_PCM_BYTES = 6400;
    static final int MAX_BASE64_CHARS = ((MAX_PCM_BYTES + 2) / 3) * 4;
    static final int AUDIO_QUEUE_BLOCKS = 8;
    static final int MAX_TEXT_CHARS = 2000;
    static final int MAX_TEXT_QUEUE = 4;

    private CallTranslationPolicy() { }

    static boolean validSessionId(String value) {
        return value != null && value.matches("[A-Za-z0-9._:-]{1,160}");
    }

    static boolean validPcmLength(int bytes) {
        return bytes > 0 && bytes <= MAX_PCM_BYTES && bytes % 2 == 0;
    }

    static String language(String value) {
        if (value == null || value.length() > 35 || !value.matches("[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*")) return "";
        return Locale.forLanguageTag(value).getLanguage().toLowerCase(Locale.ROOT);
    }

    static String installedLanguage(String requested, List<String> installed) {
        if (installed == null || language(requested).isEmpty()) return "";
        for (String candidate : installed) if (requested.equalsIgnoreCase(candidate)) return candidate;
        String base = language(requested);
        for (String candidate : installed) if (base.equals(language(candidate))) return candidate;
        return "";
    }
}
