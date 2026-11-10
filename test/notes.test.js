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
  selectNotesWindow,
  notesBudget,
  notesOutputTokens,
  planNotesUpdate,
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

test('extractExistingQuestions collects prior questions from every questions section', () => {
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
});

test('buildLiveNotesPrompt injects the anti-repetition blacklist for earlier questions', () => {
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
// ── Regression: notes must never silently lose content ──────────────────────

test('a full rewrite of typed notes keeps every heading and every carried-over line', () => {
  const current = '- Redis for session storage\n- Postgres is the primary database';
  const rewrite = [
    '📌 Summary & How It Connects:',
    '- Redis for session storage',
    '- Postgres is the primary database',
    '- Sessions are cached in Redis while durable data lives in Postgres',
    '',
    '💡 Key Insights & Technical Breakdown:',
    '- Redis keeps data in memory which makes lookups fast',
    '',
    '❓ Follow-Up Questions to Ask:',
    '- What is the eviction policy?'
  ].join('\n');

  // Not a delta: the model output replaces the notes, so nothing may be
  // "deduplicated" against the text it replaces.
  assert.strictEqual(mergeNotesSection(current, rewrite, 'update', false), rewrite);
});

test('deduplicateBullets keeps every heading that still has a bullet under it', () => {
  const existing = '📌 Live Summary:\n- The team is migrating schedules to blob storage.';
  const chunk = [
    '📌 Discussion Update (2:00 PM):',
    '- The team is migrating schedules to blob storage.',
    '- Decision: the hot tier is used for the first ninety days.',
    '',
    '✅ Action Items:',
    '- Action: Priya writes the rollback runbook.'
  ].join('\n');

  const kept = deduplicateBullets(existing, chunk);
  assert.ok(kept.includes('📌 Discussion Update (2:00 PM):'));
  assert.ok(kept.includes('✅ Action Items:'), 'second heading must survive');
  assert.ok(kept.includes('hot tier'));
  assert.ok(kept.includes('rollback runbook'));
  assert.ok(!kept.includes('- The team is migrating schedules to blob storage.'), 'the true duplicate is dropped');
});

test('deduplicateBullets drops a heading whose bullets were all duplicates', () => {
  const existing = '- Use Redis for the session cache.';
  const chunk = '📌 Discussion Update (2:00 PM):\n- Use Redis for the session cache.\n\n✅ Action Items:\n- Action: Sam benchmarks the eviction policy.';
  const kept = deduplicateBullets(existing, chunk);
  assert.ok(!kept.includes('Discussion Update'));
  assert.ok(kept.startsWith('✅ Action Items:'));
});

test('a bullet that restates an older point but adds facts is kept', () => {
  const kept = mergeNotesSection(
    '📌 Discussion Update (1:00 PM):\n- Use Redis cache',
    '📌 Discussion Update (1:05 PM):\n- Decision: use Redis cache for session tokens with a 15 minute TTL and LRU eviction',
    'update',
    true
  );
  assert.ok(kept.includes('15 minute TTL'), 'new detail must not be discarded as a duplicate');

  const withOwner = mergeNotesSection(
    '📌 Discussion Update (1:00 PM):\n- Migrate schedules to blob storage',
    '📌 Discussion Update (1:05 PM):\n- Action: Priya will migrate schedules to blob storage by Friday using the hot tier',
    'update',
    true
  );
  assert.ok(withOwner.includes('Priya'), 'owner and deadline are new information');
});

test('a bullet that only repeats part of an older, fuller point is still dropped', () => {
  const existing = '- Decision: use Redis cache for session tokens with a 15 minute TTL and LRU eviction';
  assert.strictEqual(deduplicateBullets(existing, '📌 Discussion Update (1:10 PM):\n- Use Redis cache for session tokens'), '');
});

test('a changed number is new information, not a duplicate', () => {
  const kept = deduplicateBullets('- The cache TTL is 15 minutes', '📌 Discussion Update (1:10 PM):\n- The cache TTL is 30 minutes');
  assert.ok(kept.includes('30 minutes'));
});

test('output with no bullets at all is kept rather than reported as nothing new', () => {
  const prose = 'The team agreed to move the schedule export to blob storage next sprint.';
  assert.strictEqual(deduplicateBullets('- Something unrelated that was already noted.', prose), prose);
});

// ── Context budget and cache-friendly prompt shape ──────────────────────────

test('notesBudget scales with the context size and never drops below the default', () => {
  const small = notesBudget(4096);
  const large = notesBudget(8192);
  assert.strictEqual(notesBudget(1000).contextTokens, 4096);
  assert.strictEqual(notesBudget(undefined).contextTokens, 4096);
  assert.ok(large.maxNotesChars > small.maxNotesChars);
  assert.ok(large.maxSpeechChars > small.maxSpeechChars);
  // Worst case must fit the window at ~3.5 characters per token.
  const worstCaseTokens = (small.maxNotesChars + small.maxSpeechChars) / 3.5 + 850 + notesOutputTokens('update', { rewrite: true });
  assert.ok(worstCaseTokens <= 4096, `worst case ${worstCaseTokens} tokens exceeds the window`);
});

test('notesOutputTokens gives each task its own cap', () => {
  assert.ok(notesOutputTokens('questions') < notesOutputTokens('insights'));
  assert.ok(notesOutputTokens('insights') <= notesOutputTokens('update'));
  assert.ok(notesOutputTokens('update', { rewrite: true }) >= notesOutputTokens('update'));
});

test('selectNotesWindow keeps short notes whole and bounds long ones on a line start', () => {
  assert.deepStrictEqual(selectNotesWindow('short notes', 100), { text: 'short notes', truncated: false });
  const lines = Array.from({ length: 200 }, (_, i) => `- Point number ${i} about the design`);
  const window = selectNotesWindow(lines.join('\n'), 1000);
  assert.strictEqual(window.truncated, true);
  assert.ok(window.text.length <= 1000);
  assert.ok(window.text.startsWith('- Point number'), 'window starts on a whole line');
  assert.ok(window.text.endsWith(lines[lines.length - 1]), 'the newest notes are always included');
});

test('the notes window only moves in large steps, so appended notes extend the previous prompt', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `- Point number ${i} about the design`);
  let notes = lines.join('\n');
  const before = selectNotesWindow(notes, 1000).text;
  notes += '\n- One freshly appended bullet';
  const after = selectNotesWindow(notes, 1000).text;
  assert.ok(after.startsWith(before), 'a small append must not shift the start of the window');
});

test('a long notes document yields a bounded prompt', () => {
  const budget = notesBudget(4096);
  const bigNotes = Array.from({ length: 400 }, (_, i) => `- Point number ${i} about the architecture decision and its tradeoffs`).join('\n');
  const speech = Array.from({ length: 12 }, (_, i) => ({ channel: i % 2 ? 'you' : 'them', text: `Spoken turn number ${i} with some content.`, ts: i }));
  const prompt = buildLiveNotesPrompt({
    transcript: speech, previousNotes: bigNotes, lastTurnIndex: 4, task: 'update',
    maxNotesChars: budget.maxNotesChars, maxSpeechChars: budget.maxSpeechChars
  });
  assert.ok(bigNotes.length > 20000);
  assert.ok(prompt.length < budget.maxNotesChars + budget.maxSpeechChars + 2000);
  assert.ok(prompt.includes('(Earlier notes omitted'));
  assert.ok(prompt.includes('Point number 399'), 'newest notes are present');
  assert.ok(!prompt.includes('Point number 0 '), 'oldest notes are outside the window');
});

test('update, insights and questions prompts share the same opening (cache prefix)', () => {
  const notes = '📌 Live Summary:\n- Launching Friday.\n\n❓ Questions to Ask (1:00 PM):\n- Who owns the rollback?';
  const extended = [...transcript, { channel: 'them', text: 'Also enable mTLS on the gateway.', ts: 4 }];
  const base = { transcript: extended, previousNotes: notes, lastTurnIndex: 3, timeLabel: '1:05 PM' };
  const opening = '=== CURRENT NOTES IN EDITOR ===\n' + notes + '\n\n';
  for (const task of ['update', 'insights', 'questions']) {
    const prompt = buildLiveNotesPrompt({ ...base, task });
    assert.ok(prompt.startsWith(opening), `${task} prompt must open with the unchanged notes`);
  }
});

test('prompts join consecutive fragments from the same speaker into one line', () => {
  const fragments = [
    { channel: 'them', text: 'So the plan is', ts: 1 },
    { channel: 'them', text: 'to ship on Friday.', ts: 2 },
    { channel: 'you', text: 'Understood.', ts: 3 }
  ];
  const prompt = buildLiveNotesPrompt({ transcript: fragments, previousNotes: '', lastTurnIndex: 0 });
  assert.ok(prompt.includes('Them: So the plan is to ship on Friday.'));
  assert.strictEqual(prompt.split('Them:').length - 1, 1, 'one line for the speaker, not one per fragment');
});

test('planNotesUpdate works through a long backlog in slices instead of one oversized prompt', () => {
  const budget = notesBudget(4096);
  const backlog = Array.from({ length: 200 }, (_, i) => ({ channel: 'them', text: 'word '.repeat(40) + i, ts: i }));
  const plan = planNotesUpdate({ transcript: backlog, notes: '- existing note', lastTurnIndex: 10, task: 'update', budget });
  assert.strictEqual(plan.appends, true);
  assert.ok(plan.endIndex > 10 && plan.endIndex < backlog.length, 'stops early and leaves the rest pending');

  const prompt = buildLiveNotesPrompt({
    transcript: backlog.slice(0, plan.endIndex), previousNotes: '- existing note', lastTurnIndex: 10, task: 'update',
    maxNotesChars: budget.maxNotesChars, maxSpeechChars: budget.maxSpeechChars
  });
  assert.ok(prompt.includes(backlog[10].text.trim()), 'the oldest pending turn is covered first');
  assert.ok(prompt.includes(backlog[plan.endIndex - 1].text.trim()), 'every turn up to endIndex is in the prompt');
});

test('planNotesUpdate covers everything when it fits, and rewrites only short typed notes', () => {
  const budget = notesBudget(4096);
  const plan = planNotesUpdate({ transcript, notes: '- note', lastTurnIndex: 1, task: 'update', budget });
  assert.deepStrictEqual({ endIndex: plan.endIndex, appends: plan.appends }, { endIndex: 3, appends: true });

  const short = planNotesUpdate({ transcript: [], notes: 'snyk, wiz, elastic', lastTurnIndex: 0, task: 'update', budget });
  assert.strictEqual(short.appends, false, 'short typed notes are rewritten in place');

  const longNotes = '- a typed line of notes\n'.repeat(400);
  const long = planNotesUpdate({ transcript: [], notes: longNotes, lastTurnIndex: 0, task: 'update', budget });
  assert.strictEqual(long.appendOnly, true);
  assert.strictEqual(long.appends, true, 'long typed notes get a section added, never replaced by a truncated copy');
  const prompt = buildLiveNotesPrompt({ transcript: [], previousNotes: longNotes, task: 'update', appendOnly: true, maxNotesChars: budget.maxNotesChars });
  assert.ok(prompt.includes('Task — SUMMARIZE & CONNECT THE NOTES (INCREMENTAL):'));
});

test('normalizes bulleted Questions headings and drops rephrased worm/virus questions with trailing filler', () => {
  const existing = [
    '❓ Follow-Up Questions to Ask:',
    '- Can you provide more details on the specific use cases for GitHub secret scanning?',
    '- What are the main differences between a worm and a virus in terms of their behavior and impact?',
    '',
    '✅ Action Items:',
    '- None yet.',
    '- Questions to Ask (12:57 PM):',
    '- Can you give an example of how GitHub secret scanning can prevent a security breach in a real-world scenario?',
    '- How do the replication mechanisms of worms and viruses differ, and what are the potential risks associated with each?'
  ].join('\n');

  // 1) extractExistingQuestions must find questions even when the heading was bulleted ("- Questions to Ask (12:57 PM):")
  const extracted = extractExistingQuestions(existing);
  assert.strictEqual(extracted.length, 4);
  assert.ok(extracted.some((q) => q.includes('replication mechanisms of worms and viruses')));

  // 2) Rephrased worm/virus questions with trailing filler and a bulleted heading must all be dropped
  const repeatChunk = [
    '- Questions to Ask (12:58 PM):',
    '- How do the replication mechanisms of worms and viruses differ, and what are the specific risks associated with each in terms of network security?',
    '- How do the replication mechanisms of worms and viruses differ in terms of their propagation methods and potential network impacts?'
  ].join('\n');

  assert.strictEqual(deduplicateBullets(existing, repeatChunk), '');
});
