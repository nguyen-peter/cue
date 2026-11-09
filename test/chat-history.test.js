const test = require('node:test');
const assert = require('node:assert/strict');
const { createChatHistory } = require('../src/chat-history');

test('records exchanges and returns them as alternating user/assistant turns', () => {
  const h = createChatHistory();
  h.record('What is a mutex?', 'A mutual exclusion lock…', 1000);
  h.record('And a semaphore?', 'A counter-based lock…', 2000);
  const turns = h.recent(3000);
  assert.equal(turns.length, 4);
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(turns[0].text, 'What is a mutex?');
  assert.equal(turns[3].text, 'A counter-based lock…');
});

test('keeps only the newest exchanges, evicted in whole pairs', () => {
  const h = createChatHistory({ maxExchanges: 2 });
  h.record('q1', 'a1', 1000);
  h.record('q2', 'a2', 2000);
  h.record('q3', 'a3', 3000);
  const turns = h.recent(4000);
  assert.equal(turns.length, 4);
  assert.equal(turns[0].text, 'q2');
  assert.deepEqual(turns.map((t) => t.role), ['user', 'assistant', 'user', 'assistant']);
});

test('expires exchanges past the TTL so stale context cannot mislead', () => {
  const h = createChatHistory({ ttlMs: 10000 });
  h.record('old question', 'old answer', 1000);
  h.record('new question', 'new answer', 20000);
  const turns = h.recent(25000);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'new question');
  // both halves of the old pair expired together
  assert.ok(!turns.some((t) => t.text.includes('old')));
});

test('truncates long answers but never drops the question', () => {
  const h = createChatHistory({ maxAnswerChars: 50 });
  h.record('explain quicksort', 'x'.repeat(500), 1000);
  const turns = h.recent(1000);
  assert.equal(turns[0].text, 'explain quicksort');
  assert.ok(turns[1].text.length < 100);
  assert.ok(turns[1].text.endsWith('…[answer truncated]'));
});

test('never records failed or empty answers', () => {
  const h = createChatHistory();
  h.record('did this work?', '', 1000);
  h.record('and this?', '   ', 2000);
  assert.equal(h.recent(3000).length, 0);
  assert.equal(h.size(), 0);
});

test('clear() wipes memory completely', () => {
  const h = createChatHistory();
  h.record('q', 'a', 1000);
  h.clear();
  assert.equal(h.recent(1000).length, 0);
  assert.equal(h.all().length, 0);
  assert.equal(h.sessionSize(), 0);
});

test('all() retains full-session exchanges even when recent() evicts or expires them', () => {
  const h = createChatHistory({ maxExchanges: 2, ttlMs: 5000 });
  h.record('q1', 'a1', 1000);
  h.record('q2', 'a2', 2000);
  h.record('q3', 'a3', 3000);
  h.record('q4', 'a4', 20000); // 20s later, q1-q3 expired by ttl

  // recent() only has q4 (q1-q3 expired or evicted by maxExchanges: 2)
  const recent = h.recent(21000);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].text, 'q4');

  // all() has all 4 exchanges from start to finish
  const all = h.all();
  assert.equal(all.length, 8);
  assert.equal(h.sessionSize(), 4);
  assert.equal(all[0].text, 'q1');
  assert.equal(all[1].text, 'a1');
  assert.equal(all[6].text, 'q4');
  assert.equal(all[7].text, 'a4');
});
