const test = require('node:test');
const assert = require('node:assert/strict');
const { createTokenCoalescer } = require('../src/token-coalesce');

test('coalesces many small deltas into one flush', async () => {
  const flushed = [];
  const c = createTokenCoalescer((chunk) => flushed.push(chunk), 10);
  c.push('Hel');
  c.push('lo');
  c.push('!');
  assert.deepEqual(flushed, [], 'nothing is sent until the frame timer');
  await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(flushed, ['Hello!']);
});

test('flush() sends immediately and cancels the pending timer (no double send)', async () => {
  const flushed = [];
  const c = createTokenCoalescer((chunk) => flushed.push(chunk), 50);
  c.push('ab');
  c.flush();
  assert.deepEqual(flushed, ['ab']);
  await new Promise((r) => setTimeout(r, 70));
  assert.deepEqual(flushed, ['ab']);
});

test('push after flush starts a new batch', async () => {
  const flushed = [];
  const c = createTokenCoalescer((chunk) => flushed.push(chunk), 10);
  c.push('a');
  c.flush();
  c.push('b');
  c.flush();
  assert.deepEqual(flushed, ['a', 'b']);
});

test('empty push and empty flush are no-ops', () => {
  const flushed = [];
  const c = createTokenCoalescer((chunk) => flushed.push(chunk), 10);
  c.push('');
  c.flush();
  assert.deepEqual(flushed, []);
});
