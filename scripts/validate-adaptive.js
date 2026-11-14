#!/usr/bin/env node
// Validation set for adaptive thinking: 25 real interview questions with the
// level a reviewer would pick by hand. Runs the real pipeline —
// detectCategory from src/interview-context.js, then pickAdaptiveThinking —
// and fails loudly on any mismatch, so a classifier change that makes a hard
// question LOW (a shallow answer in an interview) cannot slip through.
//
//   node scripts/validate-adaptive.js
//
// Expectations are judgement, not output: if the classifier disagrees with
// one, fix the classifier (or the expectation, with a reason in the commit),
// never just edit the expectation to match. No API calls, $0.
const { detectCategory } = require('../src/interview-context');
const { pickAdaptiveThinking } = require('../src/adaptive-thinking');

// Same screen-reference test main.js uses to decide whether a typed ask gets
// a screenshot. Copied here so the validation exercises the real gate.
const REFERENCES_SCREEN = /\b(screen|screenshot|slide|diagram|code|line|function|class|method|bug|error|exception|warning|output|terminal|console|image|chart|table|graph|window|page|browser|editor|ide|shown|visible|display|above|below|look at|read this|solve this|fix this|what is this|on screen|hackerrank|leetcode)\b/i;

const CASES = [
  // LOW: short, factual, or retrieval from stored notes.
  ['What does ACID stand for in databases?', 'LOW'],
  ['What is a mutex?', 'LOW'],
  ['Define eventual consistency.', 'LOW'],
  ['How many bits are in a byte?', 'LOW'],
  ['What is your salary expectation?', 'LOW'],
  ['Why do you want to work here?', 'LOW'],
  ['Who wrote the Linux kernel?', 'LOW'],
  ['When did you graduate?', 'LOW'],
  ['Why did you leave your last job?', 'LOW'],
  // MEDIUM: reasoning, structure, follow-ups, screen, or just long.
  ['Design a rate limiter.', 'MEDIUM'],
  ['What is the tradeoff of using Redis here?', 'MEDIUM'],
  ['What is the difference between TCP and UDP?', 'MEDIUM'],
  ['How does DNS work?', 'MEDIUM'],
  ['Tell me about a time you failed.', 'MEDIUM'],
  ['Walk me through your resume.', 'MEDIUM'],
  ['Summarize the whole case.', 'MEDIUM'],
  ['Why?', 'MEDIUM'],
  ['And the other one?', 'MEDIUM'],
  ['Explain the function on screen.', 'MEDIUM'],
  ['What is the time complexity of this?', 'MEDIUM'],
  ['How should I approach a system design question?', 'MEDIUM'],
  ['What does ACID stand for in databases and how does it relate to the transaction isolation levels we discussed earlier in this interview?', 'MEDIUM'],
  ['Can you expand on the caching layer?', 'MEDIUM'],
  ['How would you handle a production outage?', 'MEDIUM'],
  ['What is the capital of France?', 'LOW']
];

let failures = 0;
for (const [text, expected] of CASES) {
  const category = detectCategory([], text);
  const got = pickAdaptiveThinking({
    model: 'gemini-4-hydrogen',
    mode: 'ask',
    smart: true,
    userText: text,
    category,
    referencesScreen: REFERENCES_SCREEN.test(text)
  });
  const ok = got.level === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'} expected=${expected} got=${got.level} reason=${got.reason} category=${category} q=${JSON.stringify(text)}`);
}
console.log(failures === 0
  ? `all ${CASES.length} cases pass`
  : `${failures} of ${CASES.length} cases fail`);
process.exit(failures === 0 ? 0 : 1);
