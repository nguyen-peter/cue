const test = require('node:test');
const assert = require('node:assert/strict');
const { transcriptThrough } = require('../src/transcript-format');

const turns = [
  { channel: 'them', text: 'one', ts: 100 },
  { channel: 'you', text: 'two', ts: 200 },
  { channel: 'them', text: 'three', ts: 300 }
];

test('transcriptThrough returns the whole transcript without a usable timestamp', () => {
  assert.equal(transcriptThrough(turns, undefined), turns);
  assert.equal(transcriptThrough(turns, NaN), turns);
  assert.equal(transcriptThrough(turns, '200'), turns);
  assert.deepEqual(transcriptThrough(null, 200), []);
});

test('transcriptThrough ends at the turn with the given timestamp', () => {
  assert.deepEqual(transcriptThrough(turns, 200).map((t) => t.text), ['one', 'two']);
  assert.deepEqual(transcriptThrough(turns, 250).map((t) => t.text), ['one', 'two']);
  assert.equal(transcriptThrough(turns, 300), turns);
  assert.equal(transcriptThrough(turns, 9999), turns);
});

test('transcriptThrough is empty when the moment is older than everything kept', () => {
  assert.deepEqual(transcriptThrough(turns, 50), []);
});

test('transcriptThrough does not modify the transcript', () => {
  const copy = turns.slice();
  transcriptThrough(copy, 100);
  assert.equal(copy.length, 3);
});
