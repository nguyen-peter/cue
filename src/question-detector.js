// question-detector.js — finds interviewer questions in live "them" transcript
// turns so they can be queued and answered with one keypress.
//
// Pure logic with zero Electron/timer dependencies so it is unit-testable like
// interview-context.js. The caller owns the silence timer: push() is called on
// every "them" turn, and flushPending() when the speaker has gone quiet, which
// classifies a trailing fragment that never received terminal punctuation.
//
// Detection is deliberately local and heuristic (no LLM call): it runs in
// microseconds per utterance and never touches the network, so it can never
// slow down transcription or answering.

// Short acknowledgements that end in "?" but aren't real questions.
const BACKCHANNEL = new Set([
  'right', 'you know', 'okay', 'ok', 'yeah', 'yes', 'no', 'really', 'correct',
  'huh', 'so', 'sure', 'exactly', 'totally', 'i see', 'you see', 'see',
  'alright', 'all right', 'got it', 'make sense', 'makes sense',
  'does that make sense', 'you know what i mean', 'isnt it', 'is that right',
  'go ahead', 'go on', 'mhm', 'mm hmm',
  'can you hear me', 'can you see my screen', 'am i audible'
]);

// Conversational lead-ins stripped before classification, so "So, tell me
// about yourself" is recognized by its real opening words.
const LEAD_FILLER_RE = /^(?:(?:so|and|well|now|um|uh|okay|ok|alright|also|then|but|great|cool|awesome|perfect|right|yeah)[,\s]+)+/i;

// Statement-form questions — interviewer prompts that often arrive without a
// question mark ("tell me about your last role.", "walk me through the design").
const INTERROGATIVE_START_RE = /^(?:tell (?:me|us)|walk (?:me|us) through|talk (?:me|us) through|describe|explain|give (?:me|us|an)|share|what|why|how|when|where|which|who|whose|can you|could you|would you|will you|do you|did you|does|have you|has|are you|is (?:there|it|that|this)|was|were|should|shall|any (?:questions|thoughts))\b/i;

// Indirect asks — the interviewer states what they want to hear instead of
// asking it ("I'd love to hear about your last project.").
const INDIRECT_ASK_RE = /^(?:i(?:'d| would) (?:like|love) (?:to (?:hear|know|understand|learn|see|get)|(?:for )?you to)|i(?:'d| would) be (?:curious|interested)|i(?:'m| am) (?:curious|wondering|interested (?:in|to))|i was (?:curious|wondering)|i (?:want|wanted) to (?:hear|know|understand|ask)|curious (?:about|how|what|why|whether|if|to)|help (?:me|us) understand|talk to (?:me|us) about|let(?:'s| us) (?:talk about|hear about|discuss|dig into)|take (?:me|us) through)\b/i;

// A question that opens with one of these continues the question before it
// ("What was your role? And how did you handle the pushback?"), so the two are
// kept as one item instead of taking two queue slots.
const CONTINUATION_RE = /^(?:and|or|also|plus)\b[,\s]/i;
const MAX_COMPOUND_PARTS = 3;
const MAX_COMPOUND_CHARS = 320;

// The one sentence split used everywhere (detector and the history sidebar).
function splitSentences(text) {
  return String(text || '').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordCount(s) {
  const t = String(s || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

function isBackchannel(s) {
  return BACKCHANNEL.has(normalize(s));
}

// A complete sentence is a question if it ends with "?" (and isn't a
// backchannel), or if it opens like an interviewer prompt and is long enough
// to be a real ask rather than noise.
function isQuestionSentence(sentence) {
  const t = String(sentence || '').trim();
  if (!t || isBackchannel(t)) return false;
  const core = t.replace(LEAD_FILLER_RE, '').replace(/[\u2018\u2019]/g, "'");
  if (/\?$/.test(t)) return !isBackchannel(core) && wordCount(core) >= 1;
  return (INTERROGATIVE_START_RE.test(core) || INDIRECT_ASK_RE.test(core)) && wordCount(core) >= 4;
}

function createQuestionDetector({ mergeWindowMs = 6000 } = {}) {
  let pending = '';   // trailing text not yet ended by . ! ? …
  let lastTs = 0;
  const recentEmitted = []; // normalized, for dedupe when STT repeats itself
  // The question most recently emitted, while nothing but more questions has
  // followed it. A continuation ("And how…?") is appended to it.
  let last = null; // { entry, text, parts, ts }

  function remember(norm) {
    recentEmitted.push(norm);
    if (recentEmitted.length > 12) recentEmitted.shift();
  }

  // Classify one complete sentence. `found` collects { text, replaces?, tail? }:
  //   text      the question to queue
  //   replaces  set when `text` extends a question returned by an EARLIER call
  //             (that exact text); the caller should swap it in place
  //   tail      the newly heard part on its own, for when the earlier question
  //             is no longer queued (already answered or dismissed)
  function consider(found, sentence, ts) {
    if (!isQuestionSentence(sentence)) { last = null; return; }
    const text = sentence.trim().replace(/\s+/g, ' ');
    const norm = normalize(text);
    if (!norm || recentEmitted.includes(norm)) { last = null; return; }
    remember(norm);

    const merged = last ? last.text + ' ' + text : '';
    if (last && CONTINUATION_RE.test(text) && last.parts < MAX_COMPOUND_PARTS
        && ts - last.ts <= mergeWindowMs && merged.length <= MAX_COMPOUND_CHARS) {
      remember(normalize(merged));
      if (found.includes(last.entry)) {
        last.entry.text = merged;               // same call: nothing was handed out yet
        if (last.entry.replaces) last.entry.tail += ' ' + text;
      } else {
        last.entry = { text: merged, replaces: last.text, tail: text };
        found.push(last.entry);
      }
      last.text = merged; last.parts += 1; last.ts = ts;
      return;
    }
    const entry = { text };
    found.push(entry);
    last = { entry, text, parts: 1, ts };
  }

  function detect(text, ts = Date.now()) {
    const found = [];
    const clean = String(text || '').trim();
    if (!clean) return found;
    pending = (pending && ts - lastTs <= mergeWindowMs) ? pending + ' ' + clean : clean;
    lastTs = ts;

    const parts = pending.split(/(?<=[.!?…])\s+/);
    const lastComplete = /[.!?…]$/.test(parts[parts.length - 1].trim());
    const completeCount = lastComplete ? parts.length : parts.length - 1;
    for (let i = 0; i < completeCount; i++) consider(found, parts[i], ts);
    pending = lastComplete ? '' : parts[parts.length - 1];
    return found;
  }

  function flushDetailed() {
    const found = [];
    const t = pending.trim();
    pending = '';
    if (t) consider(found, t, lastTs);
    return found;
  }

  return {
    // Feed one "them" transcript turn. Returns newly detected questions as
    // { text, replaces?, tail? } (see consider()). Fragments are merged across
    // turns when they arrive close together, because batch STT often splits
    // one spoken question into several turns.
    detect,

    // Classify whatever is still pending (no terminal punctuation ever came —
    // common with some STT providers). Only confident interviewer-prompt
    // openings are emitted here, so trailing statements stay silent.
    flushDetailed,

    // Text-only forms of the two calls above.
    push(text, ts) { return detect(text, ts).map((q) => q.text); },
    flushPending() { return flushDetailed().map((q) => q.text); },

    reset() {
      pending = '';
      lastTs = 0;
      last = null;
      recentEmitted.length = 0;
    }
  };
}

module.exports = { createQuestionDetector, isQuestionSentence, splitSentences, normalize };
