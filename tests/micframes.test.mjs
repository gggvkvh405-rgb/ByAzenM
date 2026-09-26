import { createRequire } from 'module';
import test from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { parseFrames, describeFail } = require('../electron/winmic.js');

function frame(type, payload) {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeUInt32LE(body.length, 1);
  return Buffer.concat([head, body]);
}

test('parseFrames splits status and pcm across chunks', () => {
  const state = { buf: Buffer.alloc(0) };
  const status = [];
  const pcm = [];
  const blob = Buffer.concat([frame(1, 'READY\twasapi\tdefault\t16000\t1'), frame(2, Buffer.from([1, 2, 3, 4]))]);
  parseFrames(state, blob.subarray(0, 7), (s) => status.push(s), (p) => pcm.push(Buffer.from(p)));
  assert.equal(status.length, 0);
  parseFrames(state, blob.subarray(7), (s) => status.push(s), (p) => pcm.push(Buffer.from(p)));
  assert.deepEqual(status, ['READY\twasapi\tdefault\t16000\t1']);
  assert.equal(pcm.length, 1);
  assert.deepEqual([...pcm[0]], [1, 2, 3, 4]);
});

test('describeFail maps exclusive-mode and privacy codes', () => {
  assert.match(describeFail('4', ''), /монопольн/);
  assert.match(describeFail('8889000A', ''), /монопольн/);
  assert.match(describeFail('80070005', ''), /запретила/);
  assert.equal(describeFail('0', 'Add-Type failed\r\nmore'), 'Add-Type failed');
});
