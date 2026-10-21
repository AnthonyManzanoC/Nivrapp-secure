const FEED_URL = 'https://github.com/AnthonyManzanoC/Nivrapp-secure/releases/latest/download/latest.json';
const VERSION = /^(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})\.(0|[1-9]\d{0,4})$/;
const MAX_FEED_BYTES = 32768;

function trustedFeedUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return false;
    if (url.hostname === 'release-assets.githubusercontent.com') return /^\/github-production-release-asset(?:-[a-z0-9]+)?\/[^/]+\/[^/]+$/i.test(url.pathname);
    if (url.hostname !== 'github.com' || url.search) return false;
    return url.href === FEED_URL || /^\/AnthonyManzanoC\/Nivrapp-secure\/releases\/download\/v(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\.(?:0|[1-9]\d{0,4})\/latest\.json$/.test(url.pathname);
  } catch { return false; }
}

function validatedManifest(value) {
  if (!value || value.schemaVersion !== 1 || !VERSION.test(value.version) || typeof value.version !== 'string'
    || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))) throw new Error('INVALID_MANIFEST');
  const packageInfo = (platform, suffix, maxSize) => {
    const item = value[platform];
    if (!item || item.version !== value.version || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
      || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > maxSize
      || item.url !== `https://nivrapp-secure.vercel.app/downloads/Nivra-${value.version}-${suffix}`) throw new Error('INVALID_PACKAGE');
    return { version: item.version, url: item.url, sha256: item.sha256, size: item.size };
  };
  const android = packageInfo('android', 'debug.apk', 256 * 1024 * 1024);
  if (!Number.isSafeInteger(value.android.versionCode) || value.android.versionCode <= 0 || value.android.versionCode > 2147483647) throw new Error('INVALID_ANDROID_BUILD');
  android.versionCode = value.android.versionCode;
  return { schemaVersion: 1, version: value.version, publishedAt: value.publishedAt, android,
    windows: packageInfo('windows', 'Setup.exe', 512 * 1024 * 1024) };
}

async function loadLatestManifest(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    let url = FEED_URL;
    for (let hops = 0; hops < 5; hops++) {
      if (!trustedFeedUrl(url)) throw new Error('UNTRUSTED_REDIRECT');
      const response = await fetchImpl(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store',
        signal: controller.signal, headers: { Accept: 'application/json', 'User-Agent': 'Nivra-Update-Feed' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new Error('INVALID_REDIRECT');
        url = new URL(location, url).href;
        continue;
      }
      if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error('UPSTREAM_UNAVAILABLE'); }
      const reader = response.body.getReader();
      const parts = [];
      let length = 0;
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          length += result.value.byteLength;
          if (length > MAX_FEED_BYTES) throw new Error('FEED_TOO_LARGE');
          parts.push(Buffer.from(result.value));
        }
      } finally { await reader.cancel().catch(() => undefined); }
      return validatedManifest(JSON.parse(Buffer.concat(parts).toString('utf8')));
    }
    throw new Error('TOO_MANY_REDIRECTS');
  } finally { clearTimeout(timer); }
}
module.exports = { FEED_URL, trustedFeedUrl, validatedManifest, loadLatestManifest };
