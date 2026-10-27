const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../nivra-app/src/assets/call-translation-worklet.js'), 'utf8');
function create() {
  let Processor;
  const packets = [];
  vm.runInNewContext(source, {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: data => packets.push(data) }; } },
    registerProcessor(name, value) { assert.equal(name, 'nivra-call-pcm'); Processor = value; },
  });
  return { processor: new Processor(), packets };
}
test('200ms packets are mono little endian PCM16, with clipping and silent output', () => {
  const { processor, packets } = create();
  const input = Float32Array.from({ length: 3200 }, (_, i) => [0, .5, -.5, 2, -2][i % 5]);
  const output = new Float32Array(3200).fill(1);
  processor.process([[input]], [[output]]);
  assert.equal(packets.length, 1); assert.equal(packets[0].byteLength, 6400);
  const pcm = new DataView(packets[0]);
  assert.deepEqual([0, 2, 4, 6, 8].map(offset => pcm.getInt16(offset, true)), [0, 16384, -16384, 32767, -32768]);
  assert.ok(output.every(sample => sample === 0));
});
test('stereo is averaged rather than concatenated and unfinished packets stay bounded', () => {
  const { processor, packets } = create();
  for (let i = 0; i < 25; i++) processor.process([[new Float32Array(128).fill(1), new Float32Array(128).fill(-1)]], [[new Float32Array(128)]]);
  assert.equal(packets.length, 1); assert.ok(new Int16Array(packets[0]).every(sample => sample === 0));
  assert.equal(processor.offset, 0); assert.equal(processor.buffer.byteLength, 6400);
});
test('no input never emits audio and keeps the processor available for reconnection', () => {
  const { processor, packets } = create();
  for (let i = 0; i < 100; i++) assert.equal(processor.process([[]], [[new Float32Array(128).fill(1)]]), true);
  assert.equal(packets.length, 0); assert.equal(processor.offset, 0);
});
