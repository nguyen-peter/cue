// adaptive-thinking.js — pick a Gemini 4 thinking level for Smart-tier asks.
//
// Smart currently always sends MEDIUM, which is right for hard questions but
// wastes ~700 hidden thinking tokens before the first visible token on a
// question that only needs a fact back ("What does ACID stand for?").
// Adaptive thinking drops to LOW only when the question is confidently
// simple, and keeps MEDIUM for everything else.
//
// The two mistakes are not equal, so the design is deliberately conservative:
//   • a hard question on LOW can come back shallow or wrong — bad in an
//     interview, so LOW requires every gate below to pass;
//   • an easy question on MEDIUM only costs a few extra seconds, which is
//     today's behaviour anyway, so MEDIUM is the default whenever anything
//     is ambiguous, long, screen-referencing, or a follow-up.
// The classifier is regexes over the typed question plus the category cue
// already detected: free, instant, deterministic, and readable in this file.
// A model call to classify would add the latency this is trying to save.
//
// Logging: main.js writes the returned level + reason into the CUE_PERF
// trace for every ask, next to thought_tokens, so after a real interview the
// picks can be audited instead of trusted.

const CONVERSATIONAL_MODES = new Set(['ask', 'say', 'assist', 'answerThis']);

// Short, factual, single-answer questions. "What is X?" qualifies; "What is
// the difference between X and Y?" does not — comparison is a reasoning
// trigger below, so it stays MEDIUM.
const SIMPLE_PATTERNS = [
  /^(what (is|are|does|do|was|were)|define|who\b|when (did|was|is|are)|how (many|much|long|old)|is there|do (you|i) (have|offer|provide|support)|what('s| is) (the|your) (salary|pay|compensation|notice period))\b/i
];

// Anything here means the answer needs reasoning, structure, or judgement,
// not retrieval. One hit keeps MEDIUM. The word is returned in the reason
// so a bad pick can be traced to the exact trigger.
//
// Split in two because motivation questions ("why do you want to work
// here?") are retrieval from the candidate's stored notes, not reasoning —
// so 'why' and 'how do/does' are checked only AFTER the motivation and
// compensation categories have had their chance at LOW.
const HARD_TRIGGERS = [
  'design', 'tradeoff', 'trade-off', 'compare', 'comparison',
  'difference between', 'pros and cons', 'architect', 'scale', 'scaling',
  'system design', 'synthesis', 'synthesize', 'recommendation', 'summarize',
  'recap', 'whole case', 'entire case', 'walk me through',
  'tell me about a time', 'case study', 'implement', 'algorithm',
  'complexity', 'debug', 'fix this', 'negotiat', 'counteroffer',
  'explain why', 'explain how'
];
// 'how does' before 'how do': the shorter string is a prefix of the longer
// one, so list order decides which reason gets reported.
const SOFT_TRIGGERS = ['why', 'how would', 'how does', 'how do'];
const REASONING_TRIGGERS = [...HARD_TRIGGERS, ...SOFT_TRIGGERS];

// A follow-up refers to a previous answer, so it needs that context reasoned
// over — never a LOW, even when short ("Why?", "And the other one?").
const FOLLOWUP_PATTERNS = [
  // "Why?" on its own is a follow-up; "Why do you want to work here?" is
  // not — so the bare-why alternative is anchored to the end of the text.
  /^(why\?*$|what about|and (the|that|those|it)|the (other|second|next) (one)?|more detail|shorter|explain (that|this|it|the)|make (that|it) (shorter|simpler)|give me an example)\b/i,
  /\b(that|this|it) (approach|answer|solution|code)\b/i
];

const MAX_SIMPLE_WORDS = 20;
const MAX_SIMPLE_CHARS = 160;

function wordCount(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function findTrigger(text, triggers) {
  const lower = String(text || '').toLowerCase();
  return triggers.find((t) => lower.includes(t)) || null;
}

function findReasoningTrigger(text) {
  return findTrigger(text, REASONING_TRIGGERS);
}

function isFollowup(text) {
  return FOLLOWUP_PATTERNS.some((re) => re.test(String(text || '').trim()));
}

// Returns { level: 'LOW' | 'MEDIUM' | null, reason }.
// level null means adaptive does not apply here at all: use the existing
// default for this model/mode/tier. Only Gemini 4 Smart conversational asks
// ever get a level; LeetCode always keeps MEDIUM because a wrong-but-fast
// solution is worse than a slow correct one.
function pickAdaptiveThinking({ model, mode, smart, userText, category, referencesScreen } = {}) {
  if (!smart) return { level: null, reason: 'not-smart-tier' };
  if (!CONVERSATIONAL_MODES.has(mode)) return { level: null, reason: 'mode-excluded' };
  if (!/gemini-4/i.test(String(model || ''))) return { level: null, reason: 'not-gemini-4' };

  const text = String(userText || '').trim();
  if (!text) return { level: 'MEDIUM', reason: 'no-typed-question' };
  if (referencesScreen) return { level: 'MEDIUM', reason: 'screen-reference' };
  if (isFollowup(text)) return { level: 'MEDIUM', reason: 'followup-reference' };
  const hard = findTrigger(text, HARD_TRIGGERS);
  if (hard) return { level: 'MEDIUM', reason: 'reasoning-trigger:' + hard };
  if (wordCount(text) > MAX_SIMPLE_WORDS) return { level: 'MEDIUM', reason: 'too-long' };
  if (text.length > MAX_SIMPLE_CHARS) return { level: 'MEDIUM', reason: 'too-long' };

  // Retrieval, not reasoning: the answer comes from stored notes (salary
  // target, why this company). 'why' is expected here, so these categories
  // are checked before the soft triggers below.
  if (category === 'compensation') return { level: 'LOW', reason: 'compensation' };
  if (category === 'motivation') return { level: 'LOW', reason: 'motivation' };
  const soft = findTrigger(text, SOFT_TRIGGERS);
  if (soft) return { level: 'MEDIUM', reason: 'reasoning-trigger:' + soft };
  if (SIMPLE_PATTERNS.some((re) => re.test(text))) return { level: 'LOW', reason: 'simple-factual' };
  return { level: 'MEDIUM', reason: 'no-simple-pattern' };
}

module.exports = { pickAdaptiveThinking, CONVERSATIONAL_MODES, SIMPLE_PATTERNS, REASONING_TRIGGERS, FOLLOWUP_PATTERNS };
