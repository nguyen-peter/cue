// Structured meeting notes — turns a transcript into summary / key points /
// decisions / action items / follow-up. Pure + deterministic parts are
// unit-testable; the LLM call lives in main.js.

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

function formatTurns(turns) {
  return (turns || [])
    .map((t) => `${t.channel === 'them' ? 'Them' : 'You'}: ${t.text}`)
    .join('\n');
}

function formatNotesForEditor(raw) {
  return String(raw || '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`[-*•]\s*`/g, '')
    .replace(/^\s*[-*•]\s+(?:`?[-*•]`?\s*)+/gm, '- ')
    .replace(/^\s*[-*•]\s+/gm, '- ');
}

function wordSimilarity(s1, s2) {
  const getWords = (s) => new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
  const w1 = getWords(s1);
  const w2 = getWords(s2);
  if (!w1.size || !w2.size) return 0;
  let intersect = 0;
  for (const w of w1) {
    if (w2.has(w)) intersect++;
  }
  return intersect / Math.min(w1.size, w2.size);
}

function deduplicateBullets(existingText, newChunk) {
  if (!existingText || !newChunk) return newChunk;
  const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const existingLines = existingText.split(/\r?\n/).map(l => l.replace(/^[-*•]\s*/, '').trim()).filter(l => l.length > 10);
  const existingSet = new Set(existingLines.map(normalize));

  const lines = newChunk.split(/\r?\n/);
  const outLines = [];
  let headerLine = '';
  let keptBullets = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (outLines.length > 0) outLines.push(raw);
      continue;
    }
    // Check if line is a header (like 📌 Discussion Update or ❓ Questions to Ask)
    if (!/^[-*•]\s+/.test(line)) {
      headerLine = raw;
      continue;
    }

    const bulletContent = line.replace(/^[-*•]\s+/, '').trim();
    const norm = normalize(bulletContent);

    // 1. Exact or normalized match
    let isDuplicate = existingSet.has(norm);

    // 2. Substring match
    if (!isDuplicate && norm.length > 25) {
      for (const ex of existingSet) {
        if (ex.includes(norm) || norm.includes(ex)) {
          isDuplicate = true;
          break;
        }
      }
    }

    // 3. High word-overlap similarity (handles paraphrasing, rearranged clauses)
    if (!isDuplicate) {
      for (const exLine of existingLines) {
        if (wordSimilarity(bulletContent, exLine) >= 0.70) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (!isDuplicate) {
      existingSet.add(norm);
      existingLines.push(bulletContent);
      if (keptBullets === 0 && headerLine) {
        outLines.push(headerLine);
        headerLine = '';
      }
      outLines.push(line);
      keptBullets++;
    }
  }

  if (keptBullets === 0) return '';
  return outLines.join('\n');
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

function stripQuestionsSections(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/(?:^|\n)(?:#{1,6}\s*)?(?:❓\s*)?(?:Follow-Up Questions|Questions to Ask)[^\n]*(?:\n[\s\S]*?)?(?=\n(?:#{1,6}\s*)?(?:[📌💡❓🧠✅]|\b(?:Live Summary|Summary|Key Insights|Technical Breakdown|Follow-Up|Action Items|Discussion Update)\b)|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

function mergeNotesSection(currentNotes, generatedChunk, task = 'update', isDelta = false) {
  const cleanCurrent = (currentNotes || '').trim();
  const cleanChunk = (generatedChunk || '').trim();
  if (!cleanChunk) return cleanCurrent;
  if (!cleanCurrent) return cleanChunk;

  // Deduplicate against existing notes to prevent duplicate questions or updates
  const dedupedChunk = deduplicateBullets(cleanCurrent, cleanChunk);
  if (!dedupedChunk) return cleanCurrent;

  // When notes already exist, 'insights', 'questions', and delta 'update' all append
  // a new chronological block at the bottom of the notes.
  if (task === 'insights' || task === 'questions' || (task === 'update' && isDelta)) {
    return cleanCurrent + '\n\n' + dedupedChunk;
  }

  return dedupedChunk;
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

/**
 * Builds the prompt for Notes Mode actions:
 * - task = 'update' (default): Updates notes with new/recent call transcript + ties together user's manual notes. Works even when audio is off.
 * - task = 'insights': Generates ONLY the technical insights and connections for keywords/recent discussion (fast, incremental block).
 * - task = 'questions': Generates ONLY timely follow-up questions based on the latest discussion (fast, incremental block).
 */
function buildLiveNotesPrompt({ transcript = [], previousNotes = '', lastTurnIndex = 0, task = 'update', timeLabel = '' } = {}) {
  const cleanNotes = (previousNotes || '').trim();
  const hasExistingNotes = Boolean(cleanNotes);
  const hasTranscript = Array.isArray(transcript) && transcript.length > 0;
  const hasNewTurns = (hasExistingNotes ? lastTurnIndex >= 0 : lastTurnIndex > 0) && transcript.length > lastTurnIndex;
  const timeSuffix = timeLabel ? ` (${timeLabel})` : '';

  let transcriptBlock = '';
  if (hasTranscript) {
    if (hasNewTurns) {
      const startIdx = Math.max(0, lastTurnIndex - 3);
      const contextTurns = transcript.slice(startIdx, lastTurnIndex);
      const newTurns = transcript.slice(lastTurnIndex);
      transcriptBlock =
        (contextTurns.length ? 'Recent call context:\n' + formatTurns(contextTurns) + '\n\n' : '') +
        'New speech since last update:\n' + formatTurns(newTurns) + '\n\n';
    } else if (lastTurnIndex === 0) {
      const recentTurns = transcript.slice(-30);
      transcriptBlock = 'Call transcript context:\n' + formatTurns(recentTurns) + '\n\n';
    }
  }

  if (task === 'insights') {
    let focusTranscript = '';
    if (hasTranscript) {
      const start = hasNewTurns ? Math.max(0, lastTurnIndex - 4) : Math.max(0, transcript.length - 20);
      const recent = transcript.slice(start);
      focusTranscript =
        '=== RECENT CONVERSATION FROM CALL ===\n' +
        formatTurns(recent) +
        '\n\n';
    }

    return (
      (cleanNotes ? '=== RECENT NOTES IN EDITOR ===\n' + cleanNotes + '\n\n' : '') +
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
      const start = hasNewTurns ? Math.max(0, lastTurnIndex - 4) : Math.max(0, transcript.length - 12);
      const recent = transcript.slice(start);
      focusTranscript =
        '=== LATEST CONVERSATION FROM CALL ===\n' +
        formatTurns(recent) +
        '\n\n';
    }

    const existingQuestions = extractExistingQuestions(cleanNotes);
    const notesWithoutQuestions = stripQuestionsSections(cleanNotes);
    let blacklistBlock = '';
    if (existingQuestions.length > 0) {
      blacklistBlock =
        '=== PREVIOUSLY ASKED QUESTIONS (DO NOT ASK, REPHRASE, OR INVERT ANY OF THESE) ===\n' +
        existingQuestions.map(q => '- ' + q).join('\n') +
        '\n\n';
    }

    return (
      (notesWithoutQuestions ? '=== RECENT NOTES IN EDITOR ===\n' + notesWithoutQuestions + '\n\n' : '') +
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
    const newTurns = transcript.slice(lastTurnIndex);
    return (
      '=== CURRENT NOTES IN EDITOR ===\n' +
      '(Prior recorded points — do NOT duplicate these):\n' +
      cleanNotes +
      '\n\n' +
      '=== NEW SPEECH SPOKEN SINCE LAST UPDATE ===\n' +
      formatTurns(newTurns) +
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

module.exports = {
  buildNotesPrompt,
  parseNotes,
  LIVE_NOTES_SYSTEM,
  buildLiveNotesPrompt,
  findSectionBounds,
  mergeNotesSection,
  formatNotesForEditor,
  deduplicateBullets,
  extractExistingQuestions,
  stripQuestionsSections,
  wordSimilarity,
  countTranscriptWords,
  shouldAutoUpdateNotes,
  AUTO_NOTES_TURN_THRESHOLD,
  AUTO_NOTES_WORD_THRESHOLD,
  SECTION_PATTERNS
};