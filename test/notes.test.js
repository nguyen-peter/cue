const test = require('node:test');
const assert = require('node:assert');
const {
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
  countTranscriptWords,
  shouldAutoUpdateNotes,
  AUTO_NOTES_TURN_THRESHOLD,
  AUTO_NOTES_WORD_THRESHOLD
} = require('../src/notes');

const transcript = [
  { channel: 'them', text: 'We need to launch by Friday.', ts: 1 },
  { channel: 'you', text: 'I can handle the API work.', ts: 2 },
  { channel: 'them', text: 'Send the release notes to eng.', ts: 3 }
];

test('buildNotesPrompt formats speakers and preserves order', () => {
  const p = buildNotesPrompt(transcript);
  assert.ok(p.includes('Them: We need to launch by Friday.'));
  assert.ok(p.includes('You: I can handle the API work.'));
  assert.ok(p.includes('Action Items:'));
});

test('parseNotes extracts all five sections', () => {
  const blob = [
    'Meeting Summary:',
    'Ship Friday.',
    '',
    'Key Points:',
    '- launch Friday',
    '- API by me',
    '',
    'Decisions:',
    '- no scope creep',
    '',
    'Action Items:',
    '- send release notes',
    '',
    'Follow-Up:',
    '- confirm with eng'
  ].join('\n');
  const n = parseNotes(blob);
  assert.strictEqual(n.summary, 'Ship Friday.');
  assert.deepStrictEqual(n.keyPoints, ['launch Friday', 'API by me']);
  assert.deepStrictEqual(n.decisions, ['no scope creep']);
  assert.deepStrictEqual(n.actionItems, ['send release notes']);
  assert.deepStrictEqual(n.followUp, ['confirm with eng']);
});

test('parseNotes strips bullets and numeric prefixes', () => {
  const n = parseNotes('Action Items:\n- [ ] email\n1. call\n');
  assert.deepStrictEqual(n.actionItems, ['email', 'call']);
});

test('parseNotes falls back to summary when the model ignores headings', () => {
  const n = parseNotes('Just a plain recap paragraph with no structure here.');
  assert.strictEqual(n.summary, 'Just a plain recap paragraph with no structure here.');
});

test('parseNotes returns empty on blank input', () => {
  assert.deepStrictEqual(parseNotes(''), { summary: '', keyPoints: [], decisions: [], actionItems: [], followUp: [] });
});

test('buildLiveNotesPrompt builds initial prompt when no prior notes exist', () => {
  const p = buildLiveNotesPrompt({ transcript, previousNotes: '', lastTurnIndex: 0 });
  assert.ok(p.includes('Call transcript context:'));
  assert.ok(p.includes('Them: We need to launch by Friday.'));
  assert.ok(p.includes('📌 Live Summary:'));
  assert.ok(p.includes('💡 Key Insights & Technical Breakdown:'));
});

test('buildLiveNotesPrompt builds incremental delta prompt with only new turns and user manual edits', () => {
  const extended = [
    ...transcript,
    { channel: 'them', text: 'Also make sure we enable mTLS on the gateway.', ts: 4 }
  ];
  const p = buildLiveNotesPrompt({
    transcript: extended,
    previousNotes: '📌 Live Summary:\n- Launching Friday.\nsnyk',
    lastTurnIndex: 3
  });
  assert.ok(p.includes('=== CURRENT NOTES IN EDITOR ==='));
  assert.ok(p.includes('snyk'));
  assert.ok(p.includes('NEW SPEECH SPOKEN SINCE LAST UPDATE'));
  assert.ok(p.includes('Them: Also make sure we enable mTLS on the gateway.'));
});

test('buildLiveNotesPrompt ties manual keywords together when audio is off', () => {
  const p = buildLiveNotesPrompt({
    transcript: [],
    previousNotes: 'snyk, wiz, elastic',
    lastTurnIndex: 0,
    task: 'update'
  });
  assert.ok(p.includes('=== CURRENT NOTES IN EDITOR (NO AUDIO TRANSCRIPT YET) ==='));
  assert.ok(p.includes('snyk, wiz, elastic'));
  assert.ok(p.includes('Task — ORGANIZE & TIE NOTES TOGETHER:'));
});

test('buildLiveNotesPrompt supports dedicated insights and questions tasks with timeLabels', () => {
  const pInsights = buildLiveNotesPrompt({
    transcript: [{ channel: 'them', text: 'Let us use Elastic SIEM for correlation.', ts: 1 }],
    previousNotes: 'elastic search',
    lastTurnIndex: 0,
    task: 'insights',
    timeLabel: '1:20 PM'
  });
  assert.ok(pInsights.includes('Task — GENERATE ONLY THE INSIGHTS SECTION (INCREMENTAL):'));
  assert.ok(pInsights.includes('💡 Key Insights (1:20 PM):'));
  assert.ok(pInsights.includes('elastic search'));
  assert.ok(pInsights.includes('Let us use Elastic SIEM for correlation.'));
  assert.ok(!pInsights.includes('snyk'));
  assert.ok(!pInsights.includes('wiz'));

  const pQuestions = buildLiveNotesPrompt({
    transcript: [{ channel: 'them', text: 'We need to migrate schedules to blob storage.', ts: 2 }],
    previousNotes: 'elastic search',
    lastTurnIndex: 0,
    task: 'questions',
    timeLabel: '1:25 PM'
  });
  assert.ok(pQuestions.includes('Task — GENERATE ONLY THE QUESTIONS SECTION (INCREMENTAL):'));
  assert.ok(pQuestions.includes('❓ Questions to Ask (1:25 PM):'));
  assert.ok(pQuestions.includes('blob storage'));
  assert.ok(!pQuestions.includes('snyk'));
  assert.ok(!pQuestions.includes('wiz'));
});

test('buildLiveNotesPrompt dynamic scaling for update notes without 2-4 bullet cap', () => {
  const pUpdate = buildLiveNotesPrompt({
    transcript: [
      { channel: 'them', text: 'We finalized repo matching.', ts: 1 },
      { channel: 'them', text: 'Blob storage holds the schedule json.', ts: 2 },
      { channel: 'them', text: 'CLI testing script needs Python environment setup.', ts: 3 }
    ],
    previousNotes: '📌 Live Summary:\n- Call started.',
    lastTurnIndex: 1,
    task: 'update',
    timeLabel: '1:15 PM'
  });
  assert.ok(pUpdate.includes('📌 Discussion Update (1:15 PM):'));
  assert.ok(pUpdate.includes('Scale bullet count dynamically based on the amount of speech'));
  assert.ok(!pUpdate.includes('2–4 concise bullet points'));
});

test('findSectionBounds detects section ranges accurately', () => {
  const notes = 'snyk, wiz, elastic\n\n💡 Key Insights & Technical Breakdown:\n- Snyk SAST\n- Wiz CSPM\n\n❓ Follow-Up Questions to Ask:\n- Question 1?';
  const bounds = findSectionBounds(notes, 'insights');
  assert.ok(bounds);
  assert.strictEqual(notes.slice(bounds.start, bounds.end).trim().startsWith('💡 Key Insights & Technical Breakdown:'), true);

  const qBounds = findSectionBounds(notes, 'questions');
  assert.ok(qBounds);
  assert.strictEqual(notes.slice(qBounds.start, qBounds.end).trim().startsWith('❓ Follow-Up Questions to Ask:'), true);
});

test('mergeNotesSection appends fresh chronological blocks for insights, questions, and deltas', () => {
  const original = '📌 Live Summary:\n- Discussed Azure storage.';

  // Insights appends a new block
  const withInsights = mergeNotesSection(
    original,
    '💡 Key Insights (1:20 PM):\n- Azure Blob Storage: Scalable object store for JSON schedules.',
    'insights'
  );
  assert.ok(withInsights.includes('📌 Live Summary:'));
  assert.ok(withInsights.includes('💡 Key Insights (1:20 PM):'));

  // Questions appends a new block
  const withQuestions = mergeNotesSection(
    withInsights,
    '❓ Questions to Ask (1:25 PM):\n- What tier of blob storage will be used?',
    'questions'
  );
  assert.ok(withQuestions.includes('💡 Key Insights (1:20 PM):'));
  assert.ok(withQuestions.includes('❓ Questions to Ask (1:25 PM):'));

  // Discussion update delta appends a new block
  const withDelta = mergeNotesSection(
    withQuestions,
    '📌 Discussion Update (1:30 PM):\n- Configured Python CLI environment.\n- Action: Run pip install for test harness.',
    'update',
    true
  );
  assert.ok(withDelta.includes('💡 Key Insights (1:20 PM):'));
  assert.ok(withDelta.includes('❓ Questions to Ask (1:25 PM):'));
  assert.ok(withDelta.includes('📌 Discussion Update (1:30 PM):'));
});

test('formatNotesForEditor cleans double bullet markers, backticks, and markdown headers', () => {
  const input = [
    '### Section Heading',
    '- `- ` Action: Python Environment Setup for CLI Testing',
    '- - Another double bullet item',
    '- • Mixed bullet item',
    '- Normal single bullet item',
    '**Bold title:** some text',
    '---'
  ].join('\n');

  const formatted = formatNotesForEditor(input);
  assert.ok(formatted.includes('Section Heading'));
  assert.ok(!formatted.includes('###'));
  assert.ok(!formatted.includes('**'));
  assert.ok(formatted.includes('- Action: Python Environment Setup for CLI Testing'));
  assert.ok(formatted.includes('- Another double bullet item'));
  assert.ok(formatted.includes('- Mixed bullet item'));
  assert.ok(formatted.includes('- Normal single bullet item'));
  assert.ok(formatted.includes('---'));
  assert.ok(!formatted.includes('- `- `'));
  assert.ok(!formatted.includes('- - '));
});

test('extractExistingQuestions and stripQuestionsSections isolate prior questions from prompt context', () => {
  const notes = [
    '📌 Discussion Update (1:29 PM):',
    '- Action: Write to temporary file.',
    '',
    '❓ Questions to Ask (1:29 PM):',
    '- How will the application handle failure during publish?',
    '- Can you provide details on the temporary file mechanism?',
    '',
    '📌 Discussion Update (1:30 PM):',
    '- Action: Remove dataframe retention code.'
  ].join('\n');

  const questions = extractExistingQuestions(notes);
  assert.strictEqual(questions.length, 2);
  assert.strictEqual(questions[0], 'How will the application handle failure during publish?');
  assert.strictEqual(questions[1], 'Can you provide details on the temporary file mechanism?');

  const stripped = stripQuestionsSections(notes);
  assert.ok(!stripped.includes('How will the application handle failure'));
  assert.ok(!stripped.includes('❓ Questions to Ask'));
  assert.ok(stripped.includes('Write to temporary file.'));
  assert.ok(stripped.includes('Remove dataframe retention code.'));
});

test('buildLiveNotesPrompt injects anti-repetition blacklist and strips old questions', () => {
  const notes = [
    '📌 Discussion Update (1:29 PM):',
    '- Action: Write to temporary file.',
    '',
    '❓ Questions to Ask (1:29 PM):',
    '- How will the application handle failure during publish?'
  ].join('\n');

  const p = buildLiveNotesPrompt({
    transcript: [{ channel: 'them', text: 'We are removing raw dataframe output now.', ts: 10 }],
    previousNotes: notes,
    lastTurnIndex: 5,
    task: 'questions',
    timeLabel: '1:31 PM'
  });

  assert.ok(p.includes('=== PREVIOUSLY ASKED QUESTIONS (DO NOT ASK, REPHRASE, OR INVERT ANY OF THESE) ==='));
  assert.ok(p.includes('- How will the application handle failure during publish?'));
  assert.ok(p.includes('CRITICAL ANTI-REPETITION RULE'));
  assert.ok(p.includes('❓ Questions to Ask (1:31 PM):'));
});

test('deduplicateBullets drops repeated and paraphrased questions and discussion updates', () => {
  const existing = [
    '📌 Discussion Update (1:29 PM):',
    '- Action: Ensure the application writes to a temporary file.',
    '',
    '❓ Questions to Ask (1:29 PM):',
    '- How will we handle the scenario where the application fails during the publish stage, and is there a way to resume publication using the dash L argument?'
  ].join('\n');

  // Exact & paraphrased question should be dropped
  const repeatQuestions = [
    '❓ Questions to Ask (1:31 PM):',
    '- What is the process for handling the scenario where the application fails during the publish stage, and is there a way to resume publication using the dash L argument?'
  ].join('\n');

  const deduped = deduplicateBullets(existing, repeatQuestions);
  assert.strictEqual(deduped, '');

  // Fresh question should be retained
  const freshQuestions = [
    '❓ Questions to Ask (1:31 PM):',
    '- Where will the commit history for dataframes be retained?'
  ].join('\n');

  const kept = deduplicateBullets(existing, freshQuestions);
  assert.ok(kept.includes('Where will the commit history for dataframes be retained?'));
  assert.ok(kept.includes('❓ Questions to Ask (1:31 PM):'));
});

test('shouldAutoUpdateNotes triggers at turn threshold or word threshold', () => {
  // Below both thresholds
  const shortTurns = Array.from({ length: AUTO_NOTES_TURN_THRESHOLD - 1 }, (_, i) => ({
    channel: 'them',
    text: `Turn number ${i + 1}`,
    ts: i
  }));
  assert.strictEqual(shouldAutoUpdateNotes({
    modeActive: true,
    busy: false,
    pendingTurns: shortTurns.length,
    pendingWords: countTranscriptWords(shortTurns)
  }), false);

  // Meets turn threshold (8 turns)
  const eightTurns = Array.from({ length: AUTO_NOTES_TURN_THRESHOLD }, (_, i) => ({
    channel: 'them',
    text: `Turn number ${i + 1}`,
    ts: i
  }));
  assert.strictEqual(shouldAutoUpdateNotes({
    modeActive: true,
    busy: false,
    pendingTurns: eightTurns.length,
    pendingWords: countTranscriptWords(eightTurns)
  }), true);

  // Blocked when busy or inactive
  assert.strictEqual(shouldAutoUpdateNotes({
    modeActive: true,
    busy: true,
    pendingTurns: eightTurns.length,
    pendingWords: countTranscriptWords(eightTurns)
  }), false);
  assert.strictEqual(shouldAutoUpdateNotes({
    modeActive: false,
    busy: false,
    pendingTurns: eightTurns.length,
    pendingWords: countTranscriptWords(eightTurns)
  }), false);

  // Meets word threshold (150+ words) even with 1 long monologue turn
  const longMonologue = [{
    channel: 'them',
    text: Array.from({ length: AUTO_NOTES_WORD_THRESHOLD }, (_, i) => `word${i}`).join(' '),
    ts: 1
  }];
  assert.strictEqual(countTranscriptWords(longMonologue), AUTO_NOTES_WORD_THRESHOLD);
  assert.strictEqual(shouldAutoUpdateNotes({
    modeActive: true,
    busy: false,
    pendingTurns: longMonologue.length,
    pendingWords: countTranscriptWords(longMonologue)
  }), true);
});