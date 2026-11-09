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
  const core = t.replace(LEAD_FILLER_RE, '');
  if (/\?$/.test(t)) return !isBackchannel(core) && wordCount(core) >= 1;
  return INTERROGATIVE_START_RE.test(core) && wordCount(core) >= 4;
}

function createQuestionDetector({ mergeWindowMs = 6000 } = {}) {
  let pending = '';   // trailing text not yet ended by . ! ? …
  let lastTs = 0;
  const recentEmitted = []; // normalized, for dedupe when STT repeats itself

  function emit(found, sentence) {
    const text = sentence.trim().replace(/\s+/g, ' ');
    const norm = normalize(text);
    if (!norm || recentEmitted.includes(norm)) return;
    recentEmitted.push(norm);
    if (recentEmitted.length > 12) recentEmitted.shift();
    found.push(text);
  }

  return {
    // Feed one "them" transcript turn. Returns newly detected questions.
    // Fragments are merged across turns when they arrive close together,
    // because batch STT often splits one spoken question into several turns.
    push(text, ts = Date.now()) {
      const found = [];
      const clean = String(text || '').trim();
      if (!clean) return found;
      pending = (pending && ts - lastTs <= mergeWindowMs) ? pending + ' ' + clean : clean;
      lastTs = ts;

      const parts = pending.split(/(?<=[.!?…])\s+/);
      const lastComplete = /[.!?…]$/.test(parts[parts.length - 1].trim());
      const completeCount = lastComplete ? parts.length : parts.length - 1;
      for (let i = 0; i < completeCount; i++) {
        if (isQuestionSentence(parts[i])) emit(found, parts[i]);
      }
      pending = lastComplete ? '' : parts[parts.length - 1];
      return found;
    },

    // Classify whatever is still pending (no terminal punctuation ever came —
    // common with some STT providers). Only confident interviewer-prompt
    // openings are emitted here, so trailing statements stay silent.
    flushPending() {
      const found = [];
      const t = pending.trim();
      pending = '';
      if (t && isQuestionSentence(t)) emit(found, t);
      return found;
    },

    reset() {
      pending = '';
      lastTs = 0;
      recentEmitted.length = 0;
    }
  };
}

module.exports = { createQuestionDetector, isQuestionSentence, normalize };
