const test = require('node:test');
const assert = require('node:assert/strict');
const { createQuestionDetector, isQuestionSentence } = require('../src/question-detector');

// ---- sentence classification ------------------------------------------------

test('classifies ?-terminated sentences as questions', () => {
  assert.equal(isQuestionSentence('Why do you want to work here?'), true);
  assert.equal(isQuestionSentence('What is the difference between SQL and NoSQL?'), true);
  assert.equal(isQuestionSentence('Why?'), true);
});

test('classifies statement-form interviewer prompts without a question mark', () => {
  assert.equal(isQuestionSentence('Tell me about your last role.'), true);
  assert.equal(isQuestionSentence('Walk me through your resume.'), true);
  assert.equal(isQuestionSentence('So, tell me about a time you disagreed with your manager.'), true);
});

test('ignores plain statements and backchannels', () => {
  assert.equal(isQuestionSentence('We use Kubernetes for orchestration.'), false);
  assert.equal(isQuestionSentence('Right?'), false);
  assert.equal(isQuestionSentence('Okay?'), false);
  assert.equal(isQuestionSentence('You know?'), false);
  assert.equal(isQuestionSentence('Does that make sense?'), false);
  // Short interrogative-start fragments are too weak without a question mark.
  assert.equal(isQuestionSentence('Tell me about'), false);
});

// ---- streaming detection ------------------------------------------------------

test('detects a complete question in a single turn', () => {
  const d = createQuestionDetector();
  const found = d.push('Great to meet you. Why did you leave your last job?', 1000);
  assert.deepEqual(found, ['Why did you leave your last job?']);
});

test('detects multiple questions in one utterance', () => {
  const d = createQuestionDetector();
  const found = d.push('What is REST? And how does it differ from GraphQL?', 1000);
  assert.deepEqual(found, ['What is REST?', 'And how does it differ from GraphQL?']);
});

test('merges a question split across turns within the merge window', () => {
  const d = createQuestionDetector();
  assert.deepEqual(d.push('Tell me about a time you', 1000), []);
  const found = d.push('handled a conflict with a coworker?', 2500);
  assert.deepEqual(found, ['Tell me about a time you handled a conflict with a coworker?']);
});

test('does not merge fragments that arrive after the merge window', () => {
  const d = createQuestionDetector({ mergeWindowMs: 6000 });
  assert.deepEqual(d.push('And the deployment pipeline runs', 1000), []);
  // 10s later: unrelated new utterance must not glue onto the stale fragment.
  const found = d.push('What monitoring do you use?', 11000);
  assert.deepEqual(found, ['What monitoring do you use?']);
});

test('keeps an incomplete trailing fragment pending instead of emitting it', () => {
  const d = createQuestionDetector();
  const found = d.push('That sounds good. What would you say is your biggest', 1000);
  assert.deepEqual(found, []);
  const later = d.push('weakness?', 2000);
  assert.deepEqual(later, ['What would you say is your biggest weakness?']);
});

test('flushPending surfaces an unterminated interviewer prompt', () => {
  const d = createQuestionDetector();
  assert.deepEqual(d.push('walk me through your resume', 1000), []);
  assert.deepEqual(d.flushPending(), ['walk me through your resume']);
});

test('flushPending stays silent for a trailing statement', () => {
  const d = createQuestionDetector();
  assert.deepEqual(d.push('we mostly work in Python here', 1000), []);
  assert.deepEqual(d.flushPending(), []);
  // and the buffer is consumed either way
  assert.deepEqual(d.flushPending(), []);
});

test('deduplicates a question the STT repeats', () => {
  const d = createQuestionDetector();
  assert.deepEqual(d.push('Why do you want this role?', 1000), ['Why do you want this role?']);
  assert.deepEqual(d.push('Why do you want this role?', 2000), []);
});

test('reset clears pending text and the dedupe memory', () => {
  const d = createQuestionDetector();
  d.push('Tell me about a time you', 1000);
  d.reset();
  // The stale fragment must not prepend onto post-reset speech.
  assert.deepEqual(d.push('What are your salary expectations?', 1500), ['What are your salary expectations?']);
  // Dedupe memory was cleared too, so the same question can be re-emitted.
  d.reset();
  assert.deepEqual(d.push('What are your salary expectations?', 9000), ['What are your salary expectations?']);
});
