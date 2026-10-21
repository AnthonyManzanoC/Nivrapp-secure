const { loadLatestManifest } = require('../update-feed-policy.cjs');

module.exports = async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store, max-age=0');
  if (request.method === 'OPTIONS') return response.status(204).end();
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return response.status(405).json({ error: 'method_not_allowed' });
  }
  try {
    const manifest = await loadLatestManifest();
    response.setHeader('Vercel-CDN-Cache-Control', 'public, s-maxage=60');
    return request.method === 'HEAD' ? response.status(200).end() : response.status(200).json(manifest);
  } catch {
    response.setHeader('Retry-After', '60');
    return response.status(503).json({ error: 'updates_temporarily_unavailable' });
  }
};
