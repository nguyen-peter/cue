const test = require('node:test');
const assert = require('node:assert/strict');
const { MODES, LEETCODE_DEFAULT_INSTRUCTIONS, LEETCODE_FORMAT_RULES } = require('../src/prompts');

// Assist and Say now share the answer-first GENERAL_COPILOT contract: lead with
// the answer, no preamble, prioritize any visible/asked question.
test('assist mode gives a direct answer with no preamble', () => {
  const system = MODES.assist.buildSystem(null);
  const text = system + '\n' + MODES.assist.build({ transcript: [], userText: '' });
  assert.match(text, /lead with the answer/i);
  assert.match(text, /no preamble/i);
  assert.match(text, /answer it directly/i);
});

test('say mode answers the live conversation immediately', () => {
  const system = MODES.say.buildSystem(null);
  const text = system + '\n' + MODES.say.build({ transcript: [], userText: '' });
  assert.match(text, /conversation transcript/i);
  assert.match(text, /no preamble/i);
  assert.match(text, /respond now/i);
});

test('leetcode mode ignores context block and returns coding prompt', () => {
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT');
  assert.match(system, /competitive programmer|coding problem/i);
  assert.match(system, /Every line of code/i);
  assert.match(system, /opening fence on its own line/i);
  assert.match(system, /non-coder|no coding background|non-programmer/i);
  assert.match(system, /improvements or alternative/i);
  assert.match(system, /Time and space complexity/i);
  assert.match(system, /language shown on screen/i);
  assert.ok(!system.includes('IGNORED_CONTEXT'), 'leetcode should not include context block');
});

test('leetcode uses custom coding instructions in place of the default', () => {
  const custom = 'Use Java. Give a brute-force solution first, then the optimal one.';
  const system = MODES.leetcode.buildSystem('IGNORED_CONTEXT', 'IGNORED_RULES', { codingInstructions: custom });
  assert.ok(system.startsWith(custom));
  assert.ok(!system.includes(LEETCODE_DEFAULT_INSTRUCTIONS), 'custom instructions replace the default');
  assert.ok(!system.includes('IGNORED_CONTEXT'));
  assert.ok(!system.includes('IGNORED_RULES'));
});

test('leetcode always keeps the fence formatting rules, even with custom instructions', () => {
  const system = MODES.leetcode.buildSystem(null, '', { codingInstructions: 'Just give code, no comments.' });
  assert.ok(system.endsWith(LEETCODE_FORMAT_RULES));
  assert.match(system, /opening fence on its own line/i);
});

test('leetcode falls back to the default when custom instructions are blank', () => {
  for (const codingInstructions of ['', '   \n  ', undefined, null]) {
    const system = MODES.leetcode.buildSystem(null, '', { codingInstructions });
    assert.equal(system, LEETCODE_DEFAULT_INSTRUCTIONS + '\n\n' + LEETCODE_FORMAT_RULES);
  }
});

test('followup mode returns a bullet list grounded in the live screen and conversation', () => {
  const system = MODES.followup.buildSystem(null);
  const user = MODES.followup.build({
    transcript: [{ channel: 'them', text: 'Let\'s go through section 3 renewal terms.' }],
    userText: ''
  });
  assert.equal(MODES.followup.needsScreen, true, 'follow-up must capture the current screen');
  assert.match(system, /bullet list|bullets/i);
  assert.match(system, /live topic|on screen/i);
  assert.match(system, /generic/i);
  assert.match(user, /section 3 renewal/i);
  assert.match(user, /current screen is attached/i);
  assert.doesNotMatch(system, /candidate could ask the interviewer/i);
});

test('all modes have a build function', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    assert.equal(typeof mode.build, 'function', `${name}.build must be a function`);
    assert.equal(typeof mode.buildSystem, 'function', `${name}.buildSystem must be a function`);
  }
});

test('ask mode uses 12 turns for regular questions but full transcript for synthesis', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    channel: i % 2 === 0 ? 'them' : 'you',
    text: `Turn ${i + 1} content`
  }));

  // Regular question: only recent 12 turns
  const regular = MODES.ask.build({ transcript: turns, userText: 'What is the gross margin formula?' });
  assert.match(regular, /Recent conversation:/);
  assert.match(regular, /Turn 30 content/);
  assert.match(regular, /Turn 19 content/);
  assert.ok(!regular.includes('Turn 18 content'), 'should only include the last 12 turns');

  // Synthesis question: includes the very first turn and all 30 turns
  const synthesisQueries = [
    'Synthesize the case and give a final recommendation to the CEO',
    'What is your final conclusion?',
    'Give me a summary from the beginning of the case',
    'Recap all findings across the whole case'
  ];

  for (const q of synthesisQueries) {
    const res = MODES.ask.build({ transcript: turns, userText: q });
    assert.match(res, /Full interview transcript:/, `expected full transcript header for query: ${q}`);
    assert.match(res, /Turn 1 content/, `expected turn 1 to be included for query: ${q}`);
    assert.match(res, /Turn 30 content/, `expected turn 30 to be included for query: ${q}`);
  }
});

test('typed-only session: recap and ask synthesis fall back to chatHistory when audio transcript is empty', () => {
  const chatHistory = [
    { role: 'user', text: 'What is the market entry framework for MedTech Corp?' },
    { role: 'assistant', text: 'Use a 3-pillar framework: Market Attractiveness, Competition, Capabilities.' },
    { role: 'user', text: 'Calculate the breakeven units for Exhibit 2.' },
    { role: 'assistant', text: 'Breakeven is 45,000 units with $4.2M profit contribution.' }
  ];

  // recap mode with empty audio transcript falls back to typed chatHistory
  const recap = MODES.recap.build({ transcript: [], userText: '', chatHistory });
  assert.match(recap, /Full interview transcript:/);
  assert.match(recap, /MedTech Corp/);
  assert.match(recap, /45,000 units/);

  // ask mode with synthesis query falls back to typed chatHistory
  const askRes = MODES.ask.build({
    transcript: [],
    userText: 'Synthesize the entire case and give a recommendation to the CEO',
    chatHistory
  });
  assert.match(askRes, /Full interview transcript:/);
  assert.match(askRes, /MedTech Corp/);
  assert.match(askRes, /45,000 units/);
});

// ── AI rules ────────────────────────────────────────────────────────────────
const RULES = 'Never use em-dashes.\nReply in 2-3 short bullet points.\nUse a casual tone.';

test('every non-leetcode mode injects AI rules into its system prompt', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const withRules = mode.buildSystem(null, RULES);
    assert.match(withRules, /--- USER RULES ---/, `${name}.buildSystem should append USER RULES block`);
    assert.ok(withRules.includes(RULES), `${name}.buildSystem should include the user's rules verbatim`);
  }
});

test('every non-leetcode mode returns the base prompt unchanged when no rules are set', () => {
  for (const [name, mode] of Object.entries(MODES)) {
    if (name === 'leetcode') continue;
    const without = mode.buildSystem(null, '');
    const blank = mode.buildSystem(null, null);
    assert.ok(!without.includes('USER RULES'), `${name} should not include USER RULES when aiRules is empty`);
    assert.ok(!blank.includes('USER RULES'), `${name} should not include USER RULES when aiRules is null`);
  }
});

test('leetcode mode never applies AI rules (coding answers stay strict)', () => {
  const withRules = MODES.leetcode.buildSystem(null, RULES);
  assert.ok(!withRules.includes('USER RULES'), 'leetcode must not include USER RULES');
  assert.ok(!withRules.includes(RULES), 'leetcode must not leak user rules into the prompt');
  assert.match(withRules, /competitive programmer/);
});

test('assist, say, ask, and answerThis include speakable staged output structure that yields to USER RULES', () => {
  for (const modeName of ['assist', 'say', 'ask', 'answerThis']) {
    const sys = MODES[modeName].buildSystem(null, 'Respond as a McKinsey consultant using a 3-pillar framework.');
    assert.match(sys, /Stage 1 — 30-Second Speakable Talk Track/i, `${modeName} should include Stage 1 speakable talk track`);
    assert.match(sys, /Stage 2 — Deeper Detail/i, `${modeName} should include Stage 2 deeper detail`);
    assert.match(sys, /reads it out loud word-for-word/i, `${modeName} should emphasize natural spoken phrasing`);
    assert.match(sys, /--- USER RULES ---/, `${modeName} should still append USER RULES at the end so custom style wins`);
  }
});