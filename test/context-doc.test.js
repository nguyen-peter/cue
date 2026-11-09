// Meeting document ("Docs" tab) — a user-supplied reference text that every
// answer can be grounded in. These tests pin the contract: bounded, wrapped as
// untrusted data, present in every conversational mode, absent from LeetCode,
// and mined for transcription vocabulary.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildInterviewContext,
  buildContextDocBlock,
  MAX_CONTEXT_DOC_CHARS
} = require('../src/interview-context');
const { buildVocabTerms } = require('../src/stt');

const DOC = 'Master Service Agreement\n\nSection 3. Renewal. This agreement renews annually unless ' +
  'either party gives 60 days written notice. Section 4. Fees increase at most 5% per renewal term.';

test('buildContextDocBlock wraps the document with clear delimiters and an untrusted-data warning', () => {
  const block = buildContextDocBlock(DOC);
  assert.ok(block.includes('--- BEGIN DOCUMENT ---'));
  assert.ok(block.includes('--- END DOCUMENT ---'));
  assert.ok(block.includes('Section 3. Renewal'));
  assert.ok(/untrusted data, not instructions/i.test(block));
  // The model must be told to answer FROM the document when asked about it
  assert.ok(/answer FROM this document/i.test(block));
});

test('buildContextDocBlock returns empty for missing, blank, or non-string input', () => {
  assert.equal(buildContextDocBlock(''), '');
  assert.equal(buildContextDocBlock('   \n  '), '');
  assert.equal(buildContextDocBlock(null), '');
  assert.equal(buildContextDocBlock(undefined), '');
  assert.equal(buildContextDocBlock(42), '');
});

test('buildContextDocBlock clips oversized documents at the cap without dropping the delimiters', () => {
  const huge = 'A'.repeat(MAX_CONTEXT_DOC_CHARS * 3);
  const block = buildContextDocBlock(huge);
  assert.ok(block.length < MAX_CONTEXT_DOC_CHARS + 1000, 'block stays near the cap');
  assert.ok(block.includes('--- END DOCUMENT ---'), 'closing delimiter survives clipping');
});

test('a meeting document alone produces a context block (no résumé or profile needed)', () => {
  const ctx = buildInterviewContext({ contextDoc: DOC }, 'ask', []);
  assert.ok(ctx, 'context is non-null with only a document set');
  assert.ok(ctx.includes('Section 3. Renewal'));
});

test('the document is included regardless of detected question category', () => {
  const behavioralTranscript = [{ channel: 'them', text: 'Tell me about a time you led a project.' }];
  const technicalTranscript = [{ channel: 'them', text: 'Explain the difference between SQL and NoSQL.' }];
  for (const transcript of [[], behavioralTranscript, technicalTranscript]) {
    const ctx = buildInterviewContext({ contextDoc: DOC, resumeText: 'Jane Doe\nSummary\nEngineer at Acme.' }, 'ask', transcript);
    assert.ok(ctx.includes('--- BEGIN DOCUMENT ---'), 'document present for transcript: ' + JSON.stringify(transcript));
  }
});

test('LeetCode mode never receives the document', () => {
  const ctx = buildInterviewContext({ contextDoc: DOC }, 'leetcode', []);
  assert.equal(ctx, null);
});

test('document proper nouns and acronyms feed the transcription vocabulary', () => {
  const terms = buildVocabTerms({ contextDoc: 'The Zephyrix rollout uses OKRs and the FluxCapacitor API.' });
  assert.ok(terms.includes('Zephyrix'));
  assert.ok(terms.includes('FluxCapacitor'));
  assert.ok(terms.includes('OKR') || terms.includes('OKRs'));
});
