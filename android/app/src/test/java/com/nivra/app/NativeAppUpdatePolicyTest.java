package com.nivra.app;
import org.junit.Test;
import java.net.URL;
import static org.junit.Assert.*;

public class NativeAppUpdatePolicyTest {
    private final String url = "https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.0-debug.apk";
    private final String githubBase = "https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/";
    private final String hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    @Test public void acceptsOnlyOurVersionedAssetAndBoundedMetadata() {
        assertTrue(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, url));
        assertTrue(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, githubBase + "download/v4.1.0/Nivra-4.1.0-debug.apk"));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, githubBase + "download/v4.1.1/Nivra-4.1.0-debug.apk"));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, "https://release-assets.githubusercontent.com/asset?signature=signed"));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, url + "?redirect=bad"));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 80000000, "http://localhost/app.apk"));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, hash, 300000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("4.1.0", 28, "xyz", 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("../4.1.0", 28, hash, 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor(null, 28, hash, 80000000, url));
    }
    @Test public void formatsTheDigestWithoutSignedByteErrors() {
        assertEquals("00ff807f", NativeAppUpdateManager.hex(new byte[] { 0, (byte)255, (byte)128, 127 }));
    }
    @Test public void acceptsTheNextReleaseWithoutRelaxingItsDownloadOrigin() {
        String next = "https://nivrapp-secure.vercel.app/downloads/Nivra-9.0.0-debug.apk";
        assertTrue(NativeAppUpdateManager.validDescriptor("9.0.0", 90, hash, 80000000, next));
        assertFalse(NativeAppUpdateManager.validDescriptor("9.0.0", 90, hash, 80000000, url));
        assertFalse(NativeAppUpdateManager.validDescriptor("9.0.0", 90, hash, 80000000,
            "https://nivrapp-secure.onrender.com/Nivra-9.0.0-debug.apk"));
    }
    @Test public void limitsRedirectsToTheExactVersionedSiteAssetAndGithubAssetHosts() throws Exception {
        assertTrue(NativeAppUpdateManager.validDownloadUrl(new URL(url), "4.1.0"));
        assertTrue(NativeAppUpdateManager.validDownloadUrl(new URL("https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/download/v4.1.0/Nivra-4.1.0-debug.apk"), "4.1.0"));
        assertTrue(NativeAppUpdateManager.validDownloadUrl(new URL("https://release-assets.githubusercontent.com/asset?signature=temporary"), "4.1.0"));
        for (String unsafe : new String[] {
            url + "?redirect=bad", url + "#other", "http://release-assets.githubusercontent.com/asset",
            "https://nivrapp-secure.vercel.app/downloads/Nivra-4.1.1-debug.apk",
            "https://nivrapp-secure.vercel.app.evil.test/downloads/Nivra-4.1.0-debug.apk",
            "https://github.com/other/repository/releases/download/v4.1.0/Nivra-4.1.0-debug.apk",
            "https://release-assets.githubusercontent.com.evil.test/asset", "https://user:pass@objects.githubusercontent.com/asset",
            "https://objects.githubusercontent.com:8443/asset"
        }) assertFalse(unsafe, NativeAppUpdateManager.validDownloadUrl(new URL(unsafe), "4.1.0"));
    }
    @Test public void onlyFollowsTheReleaseManifestOfThePinnedRepositoryOrItsAssetHosts() throws Exception {
        assertTrue(NativeAppUpdateManager.validFeedUrl(new URL(githubBase + "latest/download/latest.json")));
        assertTrue(NativeAppUpdateManager.validFeedUrl(new URL(githubBase + "download/v10.1.1/latest.json")));
        assertTrue(NativeAppUpdateManager.validFeedUrl(new URL("https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-id?signature=signed")));
        for (String unsafe : new String[] {
            githubBase + "download/v10.1.1/other.json", githubBase + "download/v10.1.1/latest.json?redirect=x",
            githubBase + "download/v010.1.1/latest.json", "https://release-assets.githubusercontent.com/asset?signature=signed",
            "https://objects.githubusercontent.com/github-production-release-asset/123/asset-id?signature=signed",
            "https://release-assets.githubusercontent.com/github-production-release-asset/123/asset-id/extra?signature=signed",
            githubBase + "latest/download/latest.json#fragment", githubBase.replace("github.com", "github.com.evil.test") + "latest/download/latest.json",
            githubBase.replace("Nivrapp-secure", "other-repository") + "download/v10.1.1/latest.json",
            "https://nivrapp-secure.vercel.app/updates/latest.json", "http://release-assets.githubusercontent.com/asset",
            "https://user:pass@release-assets.githubusercontent.com/asset", "https://objects.githubusercontent.com:8443/asset"
        }) assertFalse(unsafe, NativeAppUpdateManager.validFeedUrl(new URL(unsafe)));
    }
    @Test public void requiresTheInstalledPackageAndTheAdvertisedNewVersionBeforeInstallation() {
        assertTrue(NativeAppUpdateManager.validArchiveMetadata("com.nivra.app", "4.1.0", 28, "com.nivra.app", "4.1.0", 28, 27));
        assertFalse(NativeAppUpdateManager.validArchiveMetadata("com.nivra.app", "4.1.0", 28, "com.other.app", "4.1.0", 28, 27));
        assertFalse(NativeAppUpdateManager.validArchiveMetadata("com.nivra.app", "4.1.0", 28, "com.nivra.app", "4.0.1", 28, 27));
        assertFalse(NativeAppUpdateManager.validArchiveMetadata("com.nivra.app", "4.1.0", 28, "com.nivra.app", "4.1.0", 27, 26));
        assertFalse(NativeAppUpdateManager.validArchiveMetadata("com.nivra.app", "4.1.0", 28, "com.nivra.app", "4.1.0", 28, 28));
    }
}
