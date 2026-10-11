const test = require('node:test');
const assert = require('node:assert/strict');
const { PINNED_API_ORIGINS, allowedApiOrigin } = require('./api-origins');
test('both compiled APIs are eligible for the desktop CORS bridge', () => {
  for (const origin of PINNED_API_ORIGINS) assert.equal(allowedApiOrigin(origin), origin);
});
test('URLs controlled by environment/query cannot add credential targets', () => {
  for (const value of ['https://attacker.test', 'https://nivra-webapp-secure.onrender.com.evil.test',
    'http://nivra-webapp-secure.onrender.com', 'https://user@nivra-webapp-secure.onrender.com',
    'https://nivra-webapp-secure.onrender.com/path', 'https://nivra-webapp-secure.onrender.com?token=x',
    'https://nivrapp-secure.onrender.com:8443', 'https://nivrapp-secure.onrender.com#token=x',
    'https://nivrapp-secure.onrender.com/health/ready', 'https://nivrapp-secure.onrender.com?next=https://attacker.test'])
    assert.equal(allowedApiOrigin(value), null);
});

test('backup preference returns only the canonical compiled origin', () => {
  const backup = PINNED_API_ORIGINS[1];
  assert.equal(allowedApiOrigin(`${backup}:443/`), backup);
  assert.equal(allowedApiOrigin(backup.toUpperCase()), backup);
  assert.equal(allowedApiOrigin({ toString: () => backup }), null);
  assert.equal(allowedApiOrigin(null), null);
  assert.equal(Object.isFrozen(PINNED_API_ORIGINS), true);
});
test('local development origins are never admitted by a packaged app', () => {
  assert.equal(allowedApiOrigin('http://localhost:5055'), null);
  assert.equal(allowedApiOrigin('http://localhost:5055', true), 'http://localhost:5055');
});
