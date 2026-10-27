package com.nivra.app;

import java.util.Arrays;
import java.util.Collections;
import org.junit.Test;
import static org.junit.Assert.*;

public class CallTranslationPolicyTest {
    @Test public void acceptsOpaqueScopedSessionIdsButRejectsUnboundedOrPathLikeInput() {
        assertTrue(CallTranslationPolicy.validSessionId("call:550e8400-e29b-41d4-a716-446655440000.1"));
        assertFalse(CallTranslationPolicy.validSessionId(null));
        assertFalse(CallTranslationPolicy.validSessionId(""));
        assertFalse(CallTranslationPolicy.validSessionId("../../other-session"));
        assertFalse(CallTranslationPolicy.validSessionId("call\nother"));
        assertFalse(CallTranslationPolicy.validSessionId(String.join("", Collections.nCopies(161, "s"))));
    }

    @Test public void acceptsAtMostTwoHundredMillisecondsOfCompletePcm16Samples() {
        assertTrue(CallTranslationPolicy.validPcmLength(2));
        assertTrue(CallTranslationPolicy.validPcmLength(16000 * 2 / 5));
        assertFalse(CallTranslationPolicy.validPcmLength(0));
        assertFalse(CallTranslationPolicy.validPcmLength(3));
        assertFalse(CallTranslationPolicy.validPcmLength(6402));
        assertFalse(CallTranslationPolicy.validPcmLength(Integer.MAX_VALUE));
    }

    @Test public void boundsBase64BeforeDecodingTheLargestPermittedChunk() {
        byte[] largest = new byte[6400];
        String encoded = java.util.Base64.getEncoder().encodeToString(largest);
        assertEquals(encoded.length(), CallTranslationPolicy.MAX_BASE64_CHARS);
        assertTrue(java.util.Base64.getEncoder().encodeToString(new byte[6404]).length() > CallTranslationPolicy.MAX_BASE64_CHARS);
    }

    @Test public void prefersAnInstalledExactLocaleOverAnotherDialect() {
        assertEquals("es-EC", CallTranslationPolicy.installedLanguage("es-EC", Arrays.asList("es-ES", "es-EC", "en-US")));
        assertEquals("es-EC", CallTranslationPolicy.installedLanguage("ES-ec", Arrays.asList("es-ES", "es-EC")));
    }

    @Test public void allowsAnInstalledDialectOfTheSelectedLanguageWithoutSubstitutingAnotherLanguage() {
        assertEquals("es-ES", CallTranslationPolicy.installedLanguage("es", Arrays.asList("en-US", "es-ES")));
        assertEquals("", CallTranslationPolicy.installedLanguage("fr", Arrays.asList("en-US", "es-ES")));
        assertEquals("", CallTranslationPolicy.installedLanguage("fr", Collections.emptyList()));
        assertEquals("", CallTranslationPolicy.installedLanguage("fr", null));
    }

    @Test public void rejectsAutomaticLanguageSelectionAndMalformedLocaleTags() {
        assertEquals("", CallTranslationPolicy.language("auto"));
        assertEquals("", CallTranslationPolicy.language(""));
        assertEquals("", CallTranslationPolicy.language(null));
        assertEquals("", CallTranslationPolicy.language("en_US"));
        assertEquals("", CallTranslationPolicy.language("https://example.invalid"));
        assertEquals("zh", CallTranslationPolicy.language("zh-Hans"));
        assertEquals("pt", CallTranslationPolicy.language("pt-BR"));
    }
}
