const PINNED_API_ORIGINS = Object.freeze([
  'https://nivrapp-secure.onrender.com',
  'https://nivra-webapp-secure.onrender.com',
  'https://nivrapp-secure-eaqi.onrender.com'
]);

function allowedApiOrigin(value, development = false) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
    if (PINNED_API_ORIGINS.includes(url.origin)) return url.origin;
    if (development && ['http://localhost:5055', 'http://127.0.0.1:5055'].includes(url.origin)) return url.origin;
    return null;
  } catch { return null; }
}
module.exports = { PINNED_API_ORIGINS, allowedApiOrigin };
