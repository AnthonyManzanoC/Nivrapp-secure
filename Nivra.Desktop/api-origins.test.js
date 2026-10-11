const test = require('node:test');
const assert = require('node:assert/strict');
const { PINNED_API_ORIGINS, allowedApiOrigin } = require('./api-origins');
test('both compiled APIs are eligible for the desktop CORS bridge', () => {
  for (const origin of PINNED_API_ORIGINS) assert.equal(allowedApiOrigin(origin), origin);
});
test('URLs controlled by environment/query cannot add credential targets', () => {
  for (const value of ['https://attacker.test', 'https://nivra-webapp-secure.onrender.com.evil.test',
    'http://nivra-webapp-secure.onrender.com', 'https://user@nivra-webapp-secure.onrender.com',
    'https://nivra-webapp-secure.onrender.com/path', 'https://nivra-webapp-secure.onrender.com?token=x'])
    assert.equal(allowedApiOrigin(value), null);
});
test('local development origins are never admitted by a packaged app', () => {
  assert.equal(allowedApiOrigin('http://localhost:5055'), null);
  assert.equal(allowedApiOrigin('http://localhost:5055', true), 'http://localhost:5055');
});
