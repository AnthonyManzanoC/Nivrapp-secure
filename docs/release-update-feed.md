# App update release feed

Android 10.2.0 and later and Windows 10.2.1 and later check the **`latest.json`** asset of the latest stable GitHub release. The clients check on startup, when returning to the foreground, and during active use. In **Cuenta → Actualizaciones de Nivra**, users can also check manually. The native download uses GitHub Releases directly and verifies the installer against the expected SHA-256 and size. Android also verifies the package and signing certificate before installation.

Versions through 10.1.1 use the previous Vercel feed. Windows 10.2.0 may also fail its update check because it rejects one of GitHub's valid release asset paths. Update these devices once by installing the corresponding APK or EXE from [GitHub Releases](https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest) over the existing installation. Future updates then use the GitHub channel.

For each version:

1. Build and verify the final APK, Windows NSIS installer and portable ZIP. Run `tools/verify-release.ps1` with the version and absolute desktop build directory.
2. The verifier compares the packaged web assets and executable versions, then writes checksums, legacy Android API metadata and `artifacts/Nivra-<version>-update-manifest.json`. The manifest contains the exact APK and installer hashes, sizes, version, Android version code and own-domain download URLs. It is generated after the packages, so no package embeds its own checksum.
3. Run `tools/publish-android-release.ps1 -Version <version> -Commit <40-character-sha> -ValidateOnly` for an offline preflight. Missing or mismatched update metadata blocks publication before any credential is read.
4. Publish with the same command without `-ValidateOnly`. The publisher uploads the versioned manifest using the remote asset name **`latest.json`**, checks every uploaded name, SHA256 digest and size, and only then publishes the draft. A published release is never overwritten.
5. Run `node tools/check-published-release.cjs <version> <40-character-sha> --artifacts <directory>` to verify the stable GitHub release, public feed and exact downloader bytes. Add `--verify-web` to check the legacy Vercel feed and download routes when they are online.

Run `tools/tests/release-feed-tests.ps1` for offline preflight and publication contract tests. The test replaces credentials and HTTP responses with temporary fixtures and checks that a mismatched remote feed digest keeps the release in draft.
