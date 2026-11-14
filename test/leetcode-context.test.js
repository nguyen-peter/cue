// LeetCode follow-ups: the last solve is kept intact so a later ask can
// iterate on the real code, and only questions phrased as follow-ups to that
// solve get the block. A fresh question must never drag old code into its
// prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLeetcodeContext, isLeetcodeFollowup, extractCode } = require('../src/leetcode-context');

const SOLVE = `(1) Two Sum: find two numbers that add to the target.
(2) Approach: one pass with a hash map.
(3) Solution:
\`\`\`python
def two_sum(nums, target):
    seen = {}  # number -> index seen so far
    for i, n in enumerate(nums):  # walk the list once
        if target - n in seen:  # complement already seen
            return [seen[target - n], i]
    return []
\`\`\`
(4) Time O(n), space O(n).`;

test('extractCode pulls the fenced block, and nothing when there is none', () => {
  assert.equal(extractCode(SOLVE), 'def two_sum(nums, target):\n    seen = {}  # number -> index seen so far\n    for i, n in enumerate(nums):  # walk the list once\n        if target - n in seen:  # complement already seen\n            return [seen[target - n], i]\n    return []');
  assert.equal(extractCode('no code here'), '');
});

test('follow-up detection only fires for questions about the solve', () => {
  for (const q of ['Make that faster.', 'Why did you pick that approach?', 'Explain that code.', 'Fix the bug in that solution.', 'What is the time complexity of that solution?', 'Can you test that function?']) {
    assert.equal(isLeetcodeFollowup(q), true, q);
  }
  for (const q of ['What is a hash map?', 'Tell me about a time you led a project.', 'Design a rate limiter.', '', 'How does DNS work?']) {
    assert.equal(isLeetcodeFollowup(q), false, q);
  }
});

test('followupBlock attaches the intact code, labelled, for a follow-up', () => {
  const ctx = createLeetcodeContext();
  ctx.record('', SOLVE, 1000);
  const block = ctx.followupBlock('Make that faster.', 1000 + 60 * 1000);
  assert.ok(block.includes('Previous coding solution (from LeetCode mode, 1 min ago)'));
  assert.ok(block.includes('def two_sum(nums, target):'));
  assert.ok(block.includes('return [seen[target - n], i]'));
  assert.ok(block.includes('Answer the follow-up about THIS solution.'));
});

test('followupBlock returns null with no solve, for a fresh question, or after expiry', () => {
  const ctx = createLeetcodeContext();
  assert.equal(ctx.followupBlock('Make that faster.', 1000), null);
  ctx.record('', SOLVE, 1000);
  assert.equal(ctx.followupBlock('What is a hash map?', 2000), null);
  assert.equal(ctx.followupBlock('Make that faster.', 1000 + 31 * 60 * 1000), null);
  assert.equal(ctx.has(1000 + 31 * 60 * 1000), false);
  assert.equal(ctx.has(1000 + 29 * 60 * 1000), true);
});

test('a new solve replaces the old one, and clear wipes it', () => {
  const ctx = createLeetcodeContext();
  ctx.record('', SOLVE, 1000);
  ctx.record('', 'no code in this one', 2000);
  const block = ctx.followupBlock('Explain that code.', 3000);
  assert.ok(block.includes('no code in this one'));
  assert.ok(!block.includes('two_sum'));
  ctx.clear();
  assert.equal(ctx.followupBlock('Explain that code.', 3000), null);
});

test('record ignores an empty answer and clips an over-long solve', () => {
  const ctx = createLeetcodeContext({ maxChars: 50 });
  ctx.record('', '', 1000);
  assert.equal(ctx.has(1000), false);
  ctx.record('', SOLVE, 1000);
  const block = ctx.followupBlock('Make that faster.', 1000);
  assert.ok(block.length < SOLVE.length);
  assert.ok(block.includes('def two_sum'));
});
