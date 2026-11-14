// Adaptive thinking: LOW only for confidently simple questions, MEDIUM for
// everything else. The conservative part is what these tests pin down —
// every ambiguous, long, screen-referencing, or follow-up question must come
// back MEDIUM, and only a short factual / compensation / motivation question
// earns LOW. If a new LOW case is added here, it needs a reason the reviewer
// can defend in an interview.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickAdaptiveThinking } = require('../src/adaptive-thinking');

const SMART_HYDROGEN = { model: 'gemini-4-hydrogen', mode: 'ask', smart: true, category: 'general', referencesScreen: false };

function pick(overrides) {
  return pickAdaptiveThinking({ ...SMART_HYDROGEN, ...overrides });
}

test('LOW for short factual questions', () => {
  const cases = [
    ['What does ACID stand for in databases?', 'simple-factual'],
    ['What is a mutex?', 'simple-factual'],
    ['Define eventual consistency.', 'simple-factual'],
    ['Who wrote the Linux kernel?', 'simple-factual'],
    ['How many bits are in a byte?', 'simple-factual'],
    ['When did you graduate?', 'simple-factual']
  ];
  for (const [text, reason] of cases) {
    assert.deepEqual(pick({ userText: text }), { level: 'LOW', reason });
  }
});

test('LOW for compensation and motivation retrieval', () => {
  assert.deepEqual(
    pick({ userText: 'What is your salary expectation?', category: 'compensation' }),
    { level: 'LOW', reason: 'compensation' }
  );
  assert.deepEqual(
    pick({ userText: 'Why do you want to work here?', category: 'motivation' }),
    { level: 'LOW', reason: 'motivation' }
  );
});

test('MEDIUM for anything that needs reasoning, however short', () => {
  const cases = [
    ['Design a rate limiter.', 'reasoning-trigger:design'],
    ['What is the tradeoff of using Redis here?', 'reasoning-trigger:tradeoff'],
    ['What is the difference between TCP and UDP?', 'reasoning-trigger:difference between'],
    ['How does DNS work?', 'reasoning-trigger:how does'],
    ['Why did you pick that approach?', 'followup-reference'],
    ['Summarize the whole case.', 'reasoning-trigger:summarize'],
    ['Walk me through your resume.', 'reasoning-trigger:walk me through'],
    ['Tell me about a time you failed.', 'reasoning-trigger:tell me about a time'],
    ['What is the time complexity of this?', 'reasoning-trigger:complexity']
  ];
  for (const [text, reason] of cases) {
    assert.deepEqual(pick({ userText: text }), { level: 'MEDIUM', reason });
  }
});

test('MEDIUM for follow-ups, even one-word ones', () => {
  for (const text of ['Why?', 'And the other one?', 'Explain that approach.', 'Make that shorter.', 'What about the second option?']) {
    assert.equal(pick({ userText: text }).level, 'MEDIUM');
  }
});

test('MEDIUM for long questions, even factual ones', () => {
  assert.deepEqual(
    pick({ userText: 'What does ACID stand for in databases and how does it relate to the transaction isolation levels we discussed earlier in this interview?' }),
    { level: 'MEDIUM', reason: 'too-long' }
  );
});

test('MEDIUM when the question references the screen', () => {
  assert.deepEqual(
    pick({ userText: 'What is this function?', referencesScreen: true }),
    { level: 'MEDIUM', reason: 'screen-reference' }
  );
});

test('MEDIUM with no typed question, and for anything that is not a simple pattern', () => {
  assert.deepEqual(pick({ userText: '' }), { level: 'MEDIUM', reason: 'no-typed-question' });
  assert.deepEqual(
    pick({ userText: 'Can you expand on the caching layer?' }),
    { level: 'MEDIUM', reason: 'no-simple-pattern' }
  );
});

test('adaptive does not apply outside Gemini 4 Smart conversational asks', () => {
  assert.deepEqual(pick({ smart: false }), { level: null, reason: 'not-smart-tier' });
  assert.deepEqual(pick({ model: 'gemini-3.8-flash' }), { level: null, reason: 'not-gemini-4' });
  assert.deepEqual(pick({ model: 'gpt-4o' }), { level: null, reason: 'not-gemini-4' });
  assert.deepEqual(pick({ mode: 'leetcode' }), { level: null, reason: 'mode-excluded' });
  assert.deepEqual(pick({ mode: 'recap' }), { level: null, reason: 'mode-excluded' });
  // Say and assist are conversational, so they get a level.
  assert.equal(pick({ mode: 'say', userText: 'What is a mutex?' }).level, 'LOW');
  assert.equal(pick({ mode: 'assist', userText: 'Design a cache.' }).level, 'MEDIUM');
});
