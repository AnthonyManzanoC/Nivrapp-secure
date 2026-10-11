const test = require('node:test');
const assert = require('node:assert/strict');
const { isBundledEntry, isTrustedIpc } = require('./renderer-security');
const entry = 'file:///C:/Nivra/resources/browser/index.html';

test('only the exact bundled document receives native privileges, allowing its app routes', () => {
  assert.equal(isBundledEntry(entry + '?electron=1#/app/chats', entry), true);
  for (const url of ['https://example.test/', 'data:text/html,test', 'file:///C:/Other/index.html', 'file://remote/Nivra/resources/browser/index.html', 'invalid']) {
    assert.equal(isBundledEntry(url, entry), false);
  }
});
test('secure IPC rejects other windows, child frames and remote navigations', () => {
  const frame = { url: entry }; const contents = { mainFrame: frame };
  const window = { isDestroyed: () => false, webContents: contents };
  assert.equal(isTrustedIpc({ sender: contents, senderFrame: frame }, window, entry), true);
  assert.equal(isTrustedIpc({ sender: {}, senderFrame: frame }, window, entry), false);
  assert.equal(isTrustedIpc({ sender: contents, senderFrame: { url: entry } }, window, entry), false);
  frame.url = 'https://example.test/';
  assert.equal(isTrustedIpc({ sender: contents, senderFrame: frame }, window, entry), false);
});
test('destroyed or absent renderer state fails closed', () => {
  assert.equal(isTrustedIpc({}, null, entry), false);
  assert.equal(isTrustedIpc({}, { isDestroyed: () => true }, entry), false);
  assert.equal(isTrustedIpc({}, { isDestroyed: () => { throw new Error('disposed'); } }, entry), false);
});
