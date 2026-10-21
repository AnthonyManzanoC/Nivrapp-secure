# App update release feed

Android and Windows discover updates from `https://nivrapp-secure.vercel.app/updates/latest.json`. Vercel serves the JSON from the GitHub release asset named **`latest.json`**. Clients do not depend on the API deployment or a redirect to a GitHub page.

For each version:

1. Build and verify the final APK, Windows NSIS installer and portable ZIP. Run `tools/verify-release.ps1` with the version and absolute desktop build directory.
2. The verifier compares the packaged web assets and executable versions, then writes checksums, legacy Android API metadata and `artifacts/Nivra-<version>-update-manifest.json`. The manifest contains the exact APK and installer hashes, sizes, version, Android version code and own-domain download URLs. It is generated after the packages, so no package embeds its own checksum.
3. Run `tools/publish-android-release.ps1 -Version <version> -Commit <40-character-sha> -ValidateOnly` for an offline preflight. Missing or mismatched update metadata blocks publication before any credential is read.
4. Publish with the same command without `-ValidateOnly`. The publisher uploads the versioned manifest using the remote asset name **`latest.json`**, checks every uploaded name, SHA256 digest and size, and only then publishes the draft. A published release is never overwritten.
5. Verify `/updates/latest.json` and the referenced downloads on the public domain. The permanent feed and generic download routes allow future versions to appear in installed apps without changing their URLs.

Run `tools/tests/release-feed-tests.ps1` for offline preflight and publication contract tests. The test replaces credentials and HTTP responses with temporary fixtures and checks that a mismatched remote feed digest keeps the release in draft.
