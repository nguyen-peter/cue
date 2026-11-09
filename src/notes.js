// Structured meeting notes — turns a transcript into summary / key points /
// decisions / action items / follow-up. Pure + deterministic parts are
// unit-testable; the LLM call lives in main.js.

const { formatTurns, countTurnsWithinBudget } = require('./transcript-format');

// Build the user turn that asks the model to write structured notes.
function buildNotesPrompt(transcript) {
  const who = (t) => (t.channel === 'them' ? 'Them' : 'You');
  const lines = transcript.map((t) => who(t) + ': ' + t.text).join('\n');
  return (
    'Meeting transcript:\n' +
    (lines || '(empty)') +
    '\n\nWrite concise meeting notes with EXACTLY these five headings, each ' +
    'heading alone on its own line:\n' +
    'Meeting Summary:\n' +
    'Key Points:\n' +
    'Decisions:\n' +
    'Action Items:\n' +
    'Follow-Up:\n' +
    'Use a hyphen at the start of each bullet. Keep Summary to 2–3 sentences.'
  );
}

const HEADERS = [
  ['summary', /^meeting summary\s*:?\s*$/i],
  ['keyPoints', /^key points\s*:?\s*$/i],
  ['decisions', /^decisions\s*:?\s*$/i],
  ['actionItems', /^action items\s*:?\s*$/i],
  ['followUp', /^follow[- ]up\s*:?\s*$/i]
];

// Parse the model's notes blob into a structured record. Forgiving: filters
// bullets, collapses duplicates, and falls back to dumping unrecognized text
// into the summary if the model ignored the requested layout.
function parseNotes(text) {
  const out = { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  if (!text || !text.trim()) return out;

  const lines = text.split(/\r?\n/);
  let cur = null;
  const buckets = { summary: [], keyPoints: [], decisions: [], actionItems: [], followUp: [] };
  for (const raw of lines) {
    const line = raw.trim();
    const matched = HEADERS.find(([, re]) => re.test(line));
    if (matched) { cur = matched[0]; continue; }
    if (!cur) continue;
    if (!line) continue; // skip blank lines without prematurely ending the section
    buckets[cur].push(line);
  }
  for (const [k, arr] of Object.entries(buckets)) {
    if (k === 'summary') { out.summary = arr.join(' ').trim(); continue; }
    out[k] = arr.map((l) => l.replace(/^[-*•]\s*/, '').replace(/^\[[ x]\]\s*/, '').replace(/^[0-9]+[.)]\s*/, '').trim()).filter(Boolean);
  }

  // If the model didn't use any heading and nothing was captured, fall back.
  const anything = Object.values(buckets).some((a) => a.length);
  if (!anything && text.trim()) out.summary = text.trim();
  return out;
}

const LIVE_NOTES_SYSTEM =
  'You are cue\'s real-time meeting and technical notetaker. ' +
  'Respond in clear, concise plain text with clean section headings and single hyphen bullets (- ) (do not use markdown ### hashes or ** bold asterisks, as the output is displayed directly inside a plain-text editor).\n\n' +
  'Core Rules:\n' +
  '1. STRICT CONFINEMENT TO INPUT: You must ONLY use the exact text provided in CURRENT NOTES and any spoken conversation in the transcript. Do NOT invent, assume, or introduce external tools, frameworks, vendors, topics, candidate backgrounds, or resumes that are not explicitly present in the input.\n' +
  '2. GENERALIZED GROUNDING: Your response must be exclusively grounded in what the user typed in the notes and what was spoken in the transcript. If the user only wrote one concept or term, explain only that specific item. If the user wrote multiple items, explain those items and how they relate. Never introduce unmentioned outside products, architectures, or topics.\n' +
  '3. NO FAKE MEETING FACTS: Never invent fake meeting decisions, deadlines, metrics, or action items that were not spoken in the transcript or written in the notes.\n' +
  '4. CO-EDITING & SHORTHAND: Treat anything in CURRENT NOTES as the user\'s ground-truth workspace. Preserve their manual notes/corrections and weave short keywords or fragments into cohesive notes.\n' +
  '5. DYNAMIC QUESTION RESOLUTION: If a question in the notes has been answered by newer transcript speech OR by notes/answers typed by the user, remove that answered question (or adjust it to the next logical follow-up) and fold the answer into the summary/insights.\n' +
  '6. Keep output tight, practical, and scannable — no intro or outro chatter.';

function formatNotesForEditor(raw) {
  return String(raw || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`[-*•]\s*`/g, '')
    .replace(/^\s*[-*•]\s+(?:`?[-*•]`?\s*)+/gm, '- ')
    .replace(/^\s*[-*•]\s+/gm, '- ');
}

// ── Context budget ───────────────────────────────────────────────────────────
// Notes run on a local model whose context window is small and whose prompt
// evaluation is slow (very slow without a GPU). Two rules follow from that:
//
//   1. The request must fit. Ollama truncates a prompt that does not, and
//      returns an answer as if nothing happened, so the model writes notes
//      from an incomplete picture and nobody is told.
//   2. The start of the prompt should not change between requests. Ollama
//      keeps the previous prompt in memory and only evaluates what comes after
//      the first difference, so a stable opening makes repeat clicks cheap.
//
// Budgets are in characters and derived from the context size, so the same
// arithmetic holds if the user raises it in Settings.
const DEFAULT_NOTES_CONTEXT_TOKENS = 4096;
const MAX_NOTES_CONTEXT_TOKENS = 32768;
const CHARS_PER_TOKEN = 3.5;      // conservative for bullet-heavy notes
const FIXED_PROMPT_TOKENS = 850;  // system prompt + the longest task instruction
const SAFETY_TOKENS = 150;
const OUTPUT_TOKENS = { update: 700, insights: 600, questions: 250, rewrite: 900 };

function normalizeNotesContextTokens(value) {
  const tokens = Math.round(Number(value));
  if (!Number.isFinite(tokens) || tokens < DEFAULT_NOTES_CONTEXT_TOKENS) return DEFAULT_NOTES_CONTEXT_TOKENS;
  return Math.min(tokens, MAX_NOTES_CONTEXT_TOKENS);
}

// A full rewrite replaces the document, so its cap is the largest; the
// incremental tasks only ever add one short section.
function notesOutputTokens(task, { rewrite = false } = {}) {
  if (rewrite) return OUTPUT_TOKENS.rewrite;
  return OUTPUT_TOKENS[task] || OUTPUT_TOKENS.update;
}

function notesBudget(contextTokens) {
  const tokens = normalizeNotesContextTokens(contextTokens);
  const available = tokens - FIXED_PROMPT_TOKENS - OUTPUT_TOKENS.rewrite - SAFETY_TOKENS;
  const chars = Math.floor(available * CHARS_PER_TOKEN);
  return {
    contextTokens: tokens,
    maxNotesChars: Math.floor(chars * 0.4),
    maxSpeechChars: Math.floor(chars * 0.6),
    // A rewrite has to fit inside its own output cap, or the tail of the
    // user's notes is replaced by a truncated copy.
    maxRewriteChars: Math.floor(OUTPUT_TOKENS.rewrite * CHARS_PER_TOKEN * 0.8)
  };
}

// The part of the notes the model sees. When the notes outgrow the budget the
// window starts later, but it moves in steps of half a window rather than on
// every update: between steps each request's notes are the previous request's
// notes plus whatever was appended, which is exactly the shape Ollama can
// reuse from its cache.
function selectNotesWindow(notes, maxChars) {
  const text = String(notes || '');
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) return { text, truncated: false };
  const step = Math.max(200, Math.floor(maxChars / 2));
  let start = Math.ceil((text.length - maxChars) / step) * step;
  const lineBreak = text.indexOf('\n', start);
  // Start on a whole line unless that would throw most of the window away.
  if (lineBreak !== -1 && text.length - (lineBreak + 1) >= maxChars / 4) start = lineBreak + 1;
  return { text: text.slice(start).replace(/^\s+/, ''), truncated: true };
}

// ── Duplicate detection ──────────────────────────────────────────────────────
const BULLET_RE = /^[-*•]\s+/;
const DUPLICATE_COVERAGE = 0.7;
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'will', 'has', 'have', 'had',
  'not', 'but', 'can', 'our', 'their', 'its', 'into', 'about', 'what', 'how', 'when', 'where', 'which',
  'who', 'why', 'does', 'did', 'should', 'would', 'could', 'there', 'then', 'than', 'been', 'being',
  'also', 'you', 'your', 'they', 'them', 'these', 'those', 'any', 'all'
]);

function normalizeLine(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// Words that carry meaning: longer than two letters and not filler. Anything
// containing a digit is always kept, so "15 minutes" and "30 minutes" differ.
function significantWords(text) {
  const words = new Set();
  for (const word of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    if (/\d/.test(word)) words.add(word);
    else if (word.length > 2 && !STOPWORDS.has(word)) words.add(word);
  }
  return words;
}

// A new bullet is redundant only when it adds nothing to a line already in the
// notes. The comparison is one-directional on purpose: "use Redis cache for
// session tokens with a 15 minute TTL" restates an older "use Redis cache" but
// carries new facts, so it is kept; the reverse would be dropped.
function isRedundantBullet(bullet, existing) {
  const norm = normalizeLine(bullet);
  if (!norm) return false;
  if (existing.norms.has(norm)) return true;
  if (norm.length > 25) {
    for (const previous of existing.norms) {
      if (previous.includes(norm)) return true;
    }
  }
  const words = significantWords(bullet);
  if (!words.size) return false;
  for (const previousWords of existing.wordSets) {
    if (!previousWords.size) continue;
    let covered = 0;
    let newNumber = false;
    for (const word of words) {
      if (previousWords.has(word)) covered += 1;
      else if (/\d/.test(word)) newNumber = true;
    }
    if (!newNumber && covered / words.size >= DUPLICATE_COVERAGE) return true;
  }
  return false;
}

// Split generated text into sections: a heading line and the bullets under it.
// An indented line after a bullet is that bullet's continuation.
function parseSections(chunk) {
  const sections = [];
  let current = { header: '', bullets: [] };
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (BULLET_RE.test(line)) {
      current.bullets.push(line);
      continue;
    }
    if (/^\s{2,}|^\t/.test(raw) && current.bullets.length) {
      current.bullets[current.bullets.length - 1] += ' ' + line;
      continue;
    }
    if (current.header || current.bullets.length) sections.push(current);
    current = { header: line, bullets: [] };
  }
  if (current.header || current.bullets.length) sections.push(current);
  return sections;
}

// Remove bullets from `newChunk` that add nothing to `existingText`. Every
// heading that still has a bullet under it is kept; a heading whose bullets
// were all redundant is dropped with them. Returns '' when nothing new is left.
function deduplicateBullets(existingText, newChunk) {
  if (!existingText || !newChunk) return newChunk;
  const sections = parseSections(newChunk);
  // Prose with no bullets cannot be compared bullet by bullet; keep it whole
  // rather than report "nothing new" for text that was never examined.
  if (!sections.some((section) => section.bullets.length)) return newChunk;

  const existingLines = existingText
    .split(/\r?\n/)
    .map((line) => line.replace(/^[-*•]\s*/, '').trim())
    .filter((line) => line.length > 10);
  const existing = {
    norms: new Set(existingLines.map(normalizeLine).filter(Boolean)),
    wordSets: existingLines.map(significantWords)
  };

  const kept = [];
  for (const section of sections) {
    const bullets = [];
    for (const line of section.bullets) {
      const content = line.replace(BULLET_RE, '').trim();
      if (isRedundantBullet(content, existing)) continue;
      // Later bullets in the same output are checked against this one too.
      const norm = normalizeLine(content);
      if (norm) existing.norms.add(norm);
      existing.wordSets.push(significantWords(content));
      bullets.push(line);
    }
    if (bullets.length) kept.push((section.header ? section.header + '\n' : '') + bullets.join('\n'));
  }
  return kept.join('\n\n');
}

function extractExistingQuestions(text) {
  if (!text || typeof text !== 'string') return [];
  const questions = [];
  const qRegex = /(?:^|\n)(?:#{1,6}\s*)?(?:❓\s*)?(?:Follow-Up Questions|Questions to Ask)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/gi;
  let match;
  while ((match = qRegex.exec(text)) !== null) {
    const block = match[0];
    const lines = block.split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (/^[-*•]\s+/.test(line)) {
        const clean = line.replace(/^[-*•]\s+/, '').trim();
        if (clean && (clean.endsWith('?') || clean.length > 15)) {
          questions.push(clean);
        }
      }
    }
  }
  return questions;
}

const SECTION_PATTERNS = {
  insights: /(?:^|\n)(?:#{1,6}\s*)?(?:💡\s*)?(?:Key Insights|Technical Breakdown)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/i,
  questions: /(?:^|\n)(?:#{1,6}\s*)?(?:❓\s*)?(?:Follow-Up Questions|Questions to Ask)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/i,
  summary: /(?:^|\n)(?:#{1,6}\s*)?(?:📌\s*)?(?:Live Summary|Summary)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/i,
  actions: /(?:^|\n)(?:#{1,6}\s*)?(?:✅\s*)?(?:Action Items)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/i,
};

function findSectionBounds(text, task) {
  if (!text || typeof text !== 'string') return null;
  const pattern = SECTION_PATTERNS[task];
  if (!pattern) return null;
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (!match) return null;
  return {
    start: match.index + (match[0].startsWith('\n') ? 1 : 0),
    end: match.index + match[0].length
  };
}

// `appends` is true whenever the model was asked for one new section to add
// below the existing notes (insights, questions, an incremental update). The
// only other case is a full rewrite, which replaces the notes outright — and a
// rewrite must NOT be deduplicated against the text it replaces, or every line
// the model carried over is deleted as a "duplicate" of itself.
function mergeNotesSection(currentNotes, generatedChunk, task = 'update', isDelta = false) {
  const cleanCurrent = (currentNotes || '').trim();
  const cleanChunk = (generatedChunk || '').trim();
  if (!cleanChunk) return cleanCurrent;
  if (!cleanCurrent) return cleanChunk;

  const appends = task === 'insights' || task === 'questions' || (task === 'update' && isDelta);
  if (!appends) return cleanChunk;

  const dedupedChunk = deduplicateBullets(cleanCurrent, cleanChunk);
  if (!dedupedChunk) return cleanCurrent;
  return cleanCurrent + '\n\n' + dedupedChunk;
}

const AUTO_NOTES_TURN_THRESHOLD = 8;
const AUTO_NOTES_WORD_THRESHOLD = 150;

function countTranscriptWords(turns) {
  if (!Array.isArray(turns) || !turns.length) return 0;
  let count = 0;
  for (const t of turns) {
    const text = (t && t.text ? String(t.text) : '').trim();
    if (text) count += text.split(/\s+/).filter(Boolean).length;
  }
  return count;
}

function shouldAutoUpdateNotes({ modeActive = false, busy = false, pendingTurns = 0, pendingWords = 0 } = {}) {
  if (!modeActive || busy) return false;
  if ((Number(pendingTurns) || 0) >= AUTO_NOTES_TURN_THRESHOLD) return true;
  if ((Number(pendingWords) || 0) >= AUTO_NOTES_WORD_THRESHOLD) return true;
  return false;
}

// Every incremental prompt opens with this exact block, whatever the task, so
// Update -> Insights -> Questions clicks share one cached prefix.
function notesBlock(notes, maxNotesChars) {
  const clean = (notes || '').trim();
  if (!clean) return '';
  const window = selectNotesWindow(clean, maxNotesChars);
  return (
    '=== CURRENT NOTES IN EDITOR ===\n' +
    (window.truncated ? '(Earlier notes omitted — most recent part shown.)\n' : '') +
    window.text +
    '\n\n'
  );
}

const MAX_BLACKLISTED_QUESTIONS = 12;

/**
 * Builds the prompt for Notes Mode actions:
 * - task = 'update' (default): Updates notes with new/recent call transcript + ties together user's manual notes. Works even when audio is off.
 * - task = 'insights': Generates ONLY the technical insights and connections for keywords/recent discussion (fast, incremental block).
 * - task = 'questions': Generates ONLY timely follow-up questions based on the latest discussion (fast, incremental block).
 *
 * `maxNotesChars` / `maxSpeechChars` bound what is sent (0 = unbounded); see
 * notesBudget(). `appendOnly` asks for one added section when the typed notes
 * are too long to rewrite safely.
 */
function buildLiveNotesPrompt({
  transcript = [],
  previousNotes = '',
  lastTurnIndex = 0,
  task = 'update',
  timeLabel = '',
  maxNotesChars = 0,
  maxSpeechChars = 0,
  appendOnly = false
} = {}) {
  const cleanNotes = (previousNotes || '').trim();
  const hasExistingNotes = Boolean(cleanNotes);
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  const hasNewTurns = (hasExistingNotes ? lastTurnIndex >= 0 : lastTurnIndex > 0) && transcript.length > lastTurnIndex;
  const timeSuffix = timeLabel ? ` (${timeLabel})` : '';
  // Newest turns that fit the speech budget, for the "what is being discussed" views.
  const recentTurns = (fromIndex) => {
    const candidates = transcript.slice(Math.max(0, fromIndex));
    return candidates.slice(candidates.length - countTurnsWithinBudget(candidates, maxSpeechChars, { fromEnd: true }));
  };
  // Oldest new turns that fit: a backlog is worked through in order, and the
  // caller advances its position by the same count (see planNotesUpdate).
  const newTurnsWithinBudget = () => {
    const candidates = transcript.slice(lastTurnIndex);
    return candidates.slice(0, countTurnsWithinBudget(candidates, maxSpeechChars));
  };

  if (task === 'insights') {
    let focusTranscript = '';
    if (hasTranscript) {
      const recent = recentTurns(hasNewTurns ? lastTurnIndex - 4 : transcript.length - 20);
      focusTranscript =
        '=== RECENT CONVERSATION FROM CALL ===\n' +
        formatTurns(recent) +
        '\n\n';
    }

    return (
      notesBlock(cleanNotes, maxNotesChars) +
      focusTranscript +
      'Task — GENERATE ONLY THE INSIGHTS SECTION (INCREMENTAL):\n' +
      'Explain the technical mechanisms, architectures, and practical connections of the tools, concepts, or terms mentioned in the RECENT conversation above (and any user notes):\n\n' +
      `💡 Key Insights${timeSuffix}:\n` +
      '- Explain ONLY the specific tools, concepts, architectures, or terms mentioned in the recent discussion or notes above.\n' +
      '- For each mentioned item, give its technical mechanism, practical purpose, and how the mentioned items connect or compare.\n' +
      '- STRICT SCOPE: Do NOT introduce or mention any outside tools, vendors, or concepts that were not in the user\'s notes or transcript above.\n\n' +
      'Output Rules:\n' +
      `- Output ONLY the "💡 Key Insights${timeSuffix}:" section starting directly with that heading line and single hyphen bullets (- ).\n` +
      '- Each bullet must start with a single hyphen (- ). Do not wrap bullets in quotes or backticks.\n' +
      '- Do NOT repeat or rewrite earlier notes or insights. Do not output preamble or closing filler.\n' +
      '- Do not use # or ** symbols.'
    );
  }

  if (task === 'questions') {
    let focusTranscript = '';
    if (hasTranscript) {
      // Prioritize the latest conversation segment (last 12 turns or speech since last update)
      const recent = recentTurns(hasNewTurns ? lastTurnIndex - 4 : transcript.length - 12);
      focusTranscript =
        '=== LATEST CONVERSATION FROM CALL ===\n' +
        formatTurns(recent) +
        '\n\n';
    }

    // Earlier questions are listed explicitly so the model sees them even when
    // they have scrolled out of the notes window. The notes themselves are
    // passed through unchanged, which keeps the cached prefix intact.
    const existingQuestions = extractExistingQuestions(cleanNotes).slice(-MAX_BLACKLISTED_QUESTIONS);
    let blacklistBlock = '';
    if (existingQuestions.length > 0) {
      blacklistBlock =
        '=== PREVIOUSLY ASKED QUESTIONS (DO NOT ASK, REPHRASE, OR INVERT ANY OF THESE) ===\n' +
        existingQuestions.map(q => '- ' + q).join('\n') +
        '\n\n';
    }

    return (
      notesBlock(cleanNotes, maxNotesChars) +
      focusTranscript +
      blacklistBlock +
      'Task — GENERATE ONLY THE QUESTIONS SECTION (INCREMENTAL):\n' +
      'Review the LATEST conversation turns above (and recent notes) and generate 2–3 timely, practical questions the user can ask RIGHT NOW in the meeting:\n\n' +
      `❓ Questions to Ask${timeSuffix}:\n` +
      '- 2–3 sharp, practical questions focused strictly on the LATEST topics, decisions, or trade-offs being discussed.\n' +
      '- CRITICAL ANTI-REPETITION RULE: You MUST NOT re-ask, paraphrase, or invert any of the previously asked questions listed above. Every question must explore a new aspect of the current discussion.\n' +
      '- STRICT SCOPE: Do NOT ask questions about outside tools, companies, or topics not present in the input above.\n\n' +
      'Output Rules:\n' +
      `- Output ONLY the "❓ Questions to Ask${timeSuffix}:" section starting directly with that heading line and single hyphen bullets (- ).\n` +
      '- Each bullet must start with a single hyphen (- ). Do not wrap bullets in quotes or backticks.\n' +
      '- Do NOT repeat or rewrite earlier notes or output preamble/closing filler.\n' +
      '- Do not use # or ** symbols.'
    );
  }

  // Default task: 'update' (Update Notes button)
  // When notes already exist and new speech was spoken during the call, do an incremental discussion update
  if (hasExistingNotes && hasNewTurns) {
    return (
      notesBlock(cleanNotes, maxNotesChars) +
      '=== NEW SPEECH SPOKEN SINCE LAST UPDATE ===\n' +
      formatTurns(newTurnsWithinBudget()) +
      '\n\n' +
      'Task — GENERATE DISCUSSION UPDATE (INCREMENTAL):\n' +
      'Capture all key technical points, architectural decisions, and action items from the NEW SPEECH above:\n\n' +
      `📌 Discussion Update${timeSuffix}:\n` +
      '- Capture ONLY new technical points, decisions, and agreements from this latest speech segment.\n' +
      '- CRITICAL ANTI-DUPLICATION RULE: Do NOT repeat, rephrase, or duplicate any actions or decisions already recorded in the prior notes above.\n' +
      '- Scale bullet count dynamically based on the amount of speech (e.g. 3–10 bullets as needed; do not artificially cap at 3–4 bullets if multiple topics or decisions were discussed).\n' +
      '- If any specific action item or decision was made, prefix the bullet with "Action:" or "Decision:" (e.g. "- Action: ...").\n\n' +
      'Output Rules:\n' +
      `- Start immediately with "📌 Discussion Update${timeSuffix}:" followed by single hyphen bullets (- ).\n` +
      '- Each bullet must start with a single hyphen (- ). Do not wrap bullets in quotes or backticks.\n' +
      '- Do NOT repeat or rewrite earlier notes.\n' +
      '- Do NOT use # or ** symbols.'
    );
  }

  if (!hasTranscript && hasExistingNotes && appendOnly) {
    // Typed notes too long to rewrite inside the output cap: add a summary
    // section below them instead of replacing them with a truncated copy.
    return (
      notesBlock(cleanNotes, maxNotesChars) +
      'Task — SUMMARIZE & CONNECT THE NOTES (INCREMENTAL):\n' +
      'Audio is currently off or no speech has been captured yet. Using only the notes above, add one short section that ties them together:\n\n' +
      `📌 Summary & How It Connects${timeSuffix}:\n` +
      '- Tie the user\'s keywords/thoughts together into clear bullets showing the big picture and how the items relate.\n' +
      '- Explain any tool, term, or concept the user wrote that the notes do not already explain.\n\n' +
      'Output Rules:\n' +
      `- Output ONLY the "📌 Summary & How It Connects${timeSuffix}:" section starting directly with that heading line and single hyphen bullets (- ).\n` +
      '- Each bullet must start with a single hyphen (- ). Do not wrap bullets in quotes or backticks.\n' +
      '- Do NOT repeat or rewrite earlier notes or output preamble/closing filler.\n' +
      '- Do not use # or ** symbols.'
    );
  }

  if (!hasTranscript && hasExistingNotes) {
    return (
      '=== CURRENT NOTES IN EDITOR (NO AUDIO TRANSCRIPT YET) ===\n' +
      cleanNotes +
      '\n\n' +
      'Task — ORGANIZE & TIE NOTES TOGETHER:\n' +
      'Audio is currently off or no speech has been captured yet. Take the user\'s manual notes/keywords above and tie them together into clean, structured notes:\n' +
      '📌 Summary & How It Connects:\n' +
      '- Tie the user\'s keywords/thoughts together into clear bullets showing the big picture and how the items relate.\n\n' +
      '💡 Key Insights & Technical Breakdown:\n' +
      '- Explain each tool, term, or concept the user wrote and how they work together technically.\n\n' +
      '❓ Follow-Up Questions to Ask:\n' +
      '- 2–3 sharp questions relevant to these topics (remove or adjust any question that the user already answered in the notes).\n\n' +
      'Each bullet must start with a single hyphen (- ). Do not use # or ** symbols. Output the complete updated notes.'
    );
  }

  let transcriptBlock = '';
  if (hasTranscript) {
    if (hasNewTurns) {
      const contextTurns = transcript.slice(Math.max(0, lastTurnIndex - 3), lastTurnIndex);
      transcriptBlock =
        (contextTurns.length ? 'Recent call context:\n' + formatTurns(contextTurns) + '\n\n' : '') +
        'New speech since last update:\n' + formatTurns(newTurnsWithinBudget()) + '\n\n';
    } else if (lastTurnIndex === 0) {
      transcriptBlock = 'Call transcript context:\n' + formatTurns(recentTurns(transcript.length - 30)) + '\n\n';
    }
  }

  return (
    (transcriptBlock || 'Call transcript: (none yet)\n\n') +
    'Task — INITIAL MEETING NOTES:\n' +
    'Generate the structured live meeting notes now using these sections:\n' +
    '📌 Live Summary:\n' +
    '- 2–4 concise bullets on the conversation and topics so far.\n\n' +
    '💡 Key Insights & Technical Breakdown:\n' +
    '- Important takeaways, decisions, and 1-line technical explanations of any tools/terms mentioned.\n\n' +
    '❓ Follow-Up Questions to Ask:\n' +
    '- 2–3 unanswered follow-up questions.\n\n' +
    '✅ Action Items:\n' +
    '- Specific next steps mentioned (or "- None yet." if none).\n\n' +
    'Each bullet must start with a single hyphen (- ). Do not use # or ** symbols. Output the complete notes.'
  );
}

/**
 * Decide what one notes request covers, so the caller and the prompt agree.
 * Returns:
 *   endIndex   — transcript position the notes will be current up to. For an
 *                incremental update over a long backlog this stops early; the
 *                remaining turns stay pending and are picked up by the next
 *                update instead of being squeezed into one oversized prompt.
 *   appends    — the result is added below the notes (false = full rewrite).
 *   appendOnly — typed notes that are too long to rewrite safely.
 */
function planNotesUpdate({ transcript = [], notes = '', lastTurnIndex = 0, task = 'update', forceFull = false, budget = notesBudget() } = {}) {
  const total = transcript.length;
  const cleanNotes = String(notes || '').trim();
  const hasNotes = !!cleanNotes;
  const isDelta = !forceFull && hasNotes && total > lastTurnIndex;
  // Same condition buildLiveNotesPrompt uses to decide it is sending "new speech".
  const sendsNewSpeech = !forceFull && total > lastTurnIndex && (hasNotes || lastTurnIndex > 0);
  let endIndex = total;
  if (task === 'update' && sendsNewSpeech) {
    endIndex = lastTurnIndex + countTurnsWithinBudget(transcript.slice(lastTurnIndex), budget.maxSpeechChars);
  }
  const appendOnly = task === 'update' && !forceFull && hasNotes && total === 0
    && cleanNotes.length > budget.maxRewriteChars;
  const appends = task === 'insights' || task === 'questions' || isDelta || appendOnly;
  return { endIndex, isDelta, appendOnly, appends };
}

module.exports = {
  buildNotesPrompt,
  parseNotes,
  LIVE_NOTES_SYSTEM,
  buildLiveNotesPrompt,
  planNotesUpdate,
  findSectionBounds,
  mergeNotesSection,
  formatNotesForEditor,
  deduplicateBullets,
  extractExistingQuestions,
  selectNotesWindow,
  notesBudget,
  notesOutputTokens,
  normalizeNotesContextTokens,
  countTranscriptWords,
  shouldAutoUpdateNotes,
  DEFAULT_NOTES_CONTEXT_TOKENS,
  AUTO_NOTES_TURN_THRESHOLD,
  AUTO_NOTES_WORD_THRESHOLD,
  SECTION_PATTERNS
};
