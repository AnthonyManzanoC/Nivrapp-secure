const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installWindowPrivacy } = require('./window-privacy');

test('startup and background remain protected until the focused app permits capture', () => {
  const window = new EventEmitter(); let focused = false, destroyed = false; const values = [];
  window.isFocused = () => focused; window.isDestroyed = () => destroyed;
  window.setContentProtection = value => values.push(value);
  const privacy = installWindowPrivacy(window);
  assert.equal(values.at(-1), true);
  focused = true; window.emit('focus'); assert.equal(values.at(-1), true);
  privacy.setProtected(false); assert.equal(values.at(-1), false);
  focused = false; window.emit('blur'); assert.equal(values.at(-1), true);
  privacy.setProtected(false); assert.equal(values.at(-1), true);
  focused = true; window.emit('focus'); assert.equal(values.at(-1), false);
  privacy.setProtected(true); window.emit('focus'); assert.equal(values.at(-1), true);
  const count = values.length; destroyed = true; window.emit('blur'); privacy.setProtected(false);
  assert.equal(values.length, count);
});
