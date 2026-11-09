const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionQueue } = require('../src/question-queue');
const { normalize } = require('../src/question-detector');

function makeQueue() {
  return createQuestionQueue({ max: 4, normalize });
}

test('detected and pinned questions share the same queue and numbering', () => {
  const q = makeQueue();
  q.addDetected('What is a mutex?');
  q.addPinned('Ask about the on-call rotation');
  const items = q.items();
  assert.equal(items.length, 2);
  assert.equal(items[0].pinned, false);
  assert.equal(items[1].pinned, true);
});

test('duplicate text is ignored regardless of origin', () => {
  const q = makeQueue();
  assert.equal(q.addDetected('What is a mutex?'), true);
  assert.equal(q.addPinned('what is a mutex'), false, 'same normalized text must not duplicate');
  assert.equal(q.size(), 1);
});

test('a detected question evicts the oldest detected, never a pinned one', () => {
  const q = makeQueue();
  q.addPinned('pinned one');
  q.addDetected('detected one?');
  q.addDetected('detected two?');
  q.addDetected('detected three?');
  assert.equal(q.size(), 4);
  q.addDetected('detected four?');
  const texts = q.items().map((i) => i.text);
  assert.ok(texts.includes('pinned one'), 'pinned survives');
  assert.ok(!texts.includes('detected one?'), 'oldest detected evicted');
  assert.ok(texts.includes('detected four?'));
});

test('when every slot is pinned, new detections are dropped', () => {
  const q = makeQueue();
  for (const t of ['a1', 'a2', 'a3', 'a4']) q.addPinned(t);
  assert.equal(q.addDetected('detected?'), false);
  assert.deepEqual(q.items().map((i) => i.text), ['a1', 'a2', 'a3', 'a4']);
});

test('a pinned add always succeeds: evicts oldest detected first, then oldest pinned', () => {
  const q = makeQueue();
  q.addPinned('p1');
  q.addDetected('d1?');
  q.addPinned('p2');
  q.addPinned('p3');
  assert.equal(q.addPinned('p4'), true);
  let texts = q.items().map((i) => i.text);
  assert.ok(!texts.includes('d1?'), 'detected evicted first');
  assert.deepEqual(texts, ['p1', 'p2', 'p3', 'p4']);

  assert.equal(q.addPinned('p5'), true, 'all-pinned queue still accepts the newest');
  texts = q.items().map((i) => i.text);
  assert.ok(!texts.includes('p1'), 'oldest pinned evicted');
  assert.ok(texts.includes('p5'));
});

test('takeAt removes and returns the slot item; ids stay stable for the rest', () => {
  const q = makeQueue();
  q.addDetected('one?');
  q.addDetected('two?');
  const idsBefore = q.items().map((i) => i.id);
  const taken = q.takeAt(0);
  assert.equal(taken.text, 'one?');
  assert.equal(q.size(), 1);
  assert.equal(q.items()[0].id, idsBefore[1]);
  assert.equal(q.takeAt(5), null);
});

test('removeById and clear behave and report change correctly', () => {
  const q = makeQueue();
  q.addPinned('keep me');
  const id = q.items()[0].id;
  assert.equal(q.removeById(999), false);
  assert.equal(q.removeById(id), true);
  assert.equal(q.size(), 0);
  assert.equal(q.clear(), false, 'clearing an empty queue reports no change');
  q.addDetected('x?');
  assert.equal(q.clear(), true);
});

test('blank or unnormalizable text is rejected', () => {
  const q = makeQueue();
  assert.equal(q.addPinned('   '), false);
  assert.equal(q.addPinned(null), false);
  assert.equal(q.size(), 0);
});
