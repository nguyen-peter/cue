// The Q&A system prompt is laid out so the part that never changes comes
// first. Providers reuse (cache) a prompt only up to its first difference, so
// these tests pin that the meeting document, résumé and job description stay
// byte-for-byte identical at the start of every ask.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildInterviewContext, buildInterviewContextParts, detectCategory } = require('../src/interview-context');
const { MODES, formatTranscript } = require('../src/prompts');

const settings = {
  resumeText: [
    'Jordan Rivera',
    'Summary',
    'Platform engineer with 8 years building CI/CD and cloud infrastructure.',
    'Experience',
    ...Array.from({ length: 30 }, (_, i) => `- Led migration ${i} of services to Kubernetes on EKS using Terraform and ArgoCD.`),
    'Skills',
    'Kubernetes, Terraform, AWS, Python, Go, ArgoCD, Datadog'
  ].join('\n'),
  jobDescription: 'Senior SRE role. ' + 'Own reliability for the payments platform. '.repeat(20),
  contextDoc: 'Design doc. ' + 'The gateway terminates mTLS and forwards to the ledger service. '.repeat(60),
  starStories: 'Story 1: ' + 'We had an outage and I led the response. '.repeat(20),
  whyCompany: 'I admire the reliability culture.',
  salaryTarget: '$170k-$200k',
  questionsToAsk: 'What does success look like in 90 days?'
};

const CATEGORIES = ['behavioral', 'motivation', 'situational', 'experience', 'compensation', 'technical', 'general'];
const parts = (category) => buildInterviewContextParts(settings, 'ask', [], 'x', category);

test('the fixed context is identical for every question category', () => {
  const fixed = parts('technical').fixed;
  assert.ok(fixed.includes('--- BEGIN DOCUMENT ---'));
  assert.ok(fixed.includes('Jordan Rivera'));
  assert.ok(fixed.includes('Target Role / Job Description'));
  assert.ok(fixed.includes('Grounding & Source Citation Rules'));
  for (const category of CATEGORIES) {
    assert.equal(parts(category).fixed, fixed, `${category} must not change the fixed part`);
  }
});

test('category-specific blocks live in the dynamic part only', () => {
  assert.ok(parts('behavioral').dynamic.includes('STAR Stories'));
  assert.ok(parts('compensation').dynamic.includes('$170k-$200k'));
  assert.ok(parts('motivation').dynamic.includes('Why This Company'));
  assert.equal(parts('technical').dynamic, '');
  assert.ok(!parts('behavioral').fixed.includes('STAR Stories'));
  assert.ok(!parts('compensation').fixed.includes('$170k-$200k'));
});

test('technical questions now see the same résumé as behavioral ones', () => {
  // Previously clipped to 900 characters for technical questions.
  assert.ok(parts('technical').fixed.includes('Led migration 20 of services'));
});

test('every conversational mode opens with the fixed context, then instructions, then category blocks, then user rules', () => {
  const rules = 'Never use em-dashes.';
  const context = parts('behavioral');
  for (const mode of ['assist', 'say', 'ask', 'answerThis', 'followup', 'recap']) {
    const system = MODES[mode].buildSystem(context, rules, settings);
    assert.ok(system.startsWith(context.fixed + '\n\n'), `${mode} must start with the fixed context`);
    const instructions = system.indexOf('You are cue');
    const stories = system.indexOf('STAR Stories');
    const userRules = system.indexOf('--- USER RULES ---');
    assert.ok(instructions > context.fixed.length, `${mode}: instructions follow the fixed context`);
    assert.ok(stories > instructions, `${mode}: category blocks follow the instructions`);
    assert.ok(userRules > stories, `${mode}: user rules stay last so they win`);
  }
});

test('two asks of different categories share the whole fixed context as a common prefix', () => {
  const a = MODES.ask.buildSystem(parts('technical'), '', settings);
  const b = MODES.answerThis.buildSystem(parts('behavioral'), '', settings);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const fixedLength = parts('technical').fixed.length;
  assert.ok(shared >= fixedLength, `shared prefix ${shared} is shorter than the fixed context ${fixedLength}`);
  // ~4 characters per token: comfortably past the 1,024-token minimum that
  // OpenAI and Gemini need before they cache a prefix.
  assert.ok(fixedLength / 4 > 1024);
});

test('buildInterviewContext still returns everything as one string', () => {
  const context = buildInterviewContext(settings, 'ask', [], 'x', 'behavioral');
  const { fixed, dynamic } = parts('behavioral');
  assert.equal(context, fixed + '\n\n' + dynamic);
});

test('a mode given no context, or a plain string, behaves as before', () => {
  const base = MODES.ask.buildSystem(null, '');
  assert.ok(base.startsWith('You are cue'));
  assert.equal(MODES.ask.buildSystem('', ''), base);
  assert.ok(MODES.ask.buildSystem('LEGACY_BLOCK', '').startsWith('LEGACY_BLOCK\n\nYou are cue'));
  assert.equal(MODES.ask.buildSystem({ fixed: '', dynamic: '' }, ''), base);
  assert.ok(MODES.ask.buildSystem({ fixed: '', dynamic: 'Salary Target:\n$1' }, '').endsWith('Salary Target:\n$1'));
});

// ── Category detection: the newest question decides ─────────────────────────

test('a new technical question outranks an older behavioral one', () => {
  const transcript = [
    { channel: 'them', text: 'Tell me about a time you failed.' },
    { channel: 'you', text: 'Sure. At my last company we shipped a bad migration.' },
    { channel: 'them', text: 'Okay. What is the difference between SQL and NoSQL?' }
  ];
  assert.equal(detectCategory(transcript), 'technical');
});

test('a question split across speech-to-text fragments is still recognized', () => {
  const transcript = [
    { channel: 'them', text: 'So tell me about a' },
    { channel: 'them', text: 'time you had a conflict with a teammate.' }
  ];
  assert.equal(detectCategory(transcript), 'behavioral');
});

test('a filler reply from the interviewer falls back to their earlier question', () => {
  const transcript = [
    { channel: 'them', text: 'What are your salary expectations?' },
    { channel: 'you', text: 'Let me think about that.' },
    { channel: 'them', text: 'Mm-hm, take your time.' }
  ];
  assert.equal(detectCategory(transcript), 'compensation');
});

test('only the last few interviewer turns are considered', () => {
  const transcript = [
    { channel: 'them', text: 'Tell me about a time you failed.' },
    ...Array.from({ length: 6 }, (_, i) => [
      { channel: 'you', text: `Answer ${i}.` },
      { channel: 'them', text: 'Right.' }
    ]).flat()
  ];
  assert.equal(detectCategory(transcript), 'general');
});

// ── Transcript formatting shared with Notes ─────────────────────────────────

test('formatTranscript joins same-speaker fragments and keeps the turn limit', () => {
  const turns = [
    { channel: 'them', text: 'old turn' },
    { channel: 'them', text: 'How would you' },
    { channel: 'them', text: 'design a cache?' },
    { channel: 'you', text: 'I would start with' },
    { channel: 'you', text: 'the access pattern.' }
  ];
  assert.equal(formatTranscript(turns, 4), 'Them: How would you design a cache?\nYou: I would start with the access pattern.');
  assert.equal(formatTranscript(turns, 0).split('\n').length, 2);
  assert.equal(formatTranscript([], 5), '');
});
