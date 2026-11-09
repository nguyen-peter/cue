#!/usr/bin/env node
// Notes benchmark: replays a scripted meeting against the local Ollama model
// that Notes mode uses and reports, for every request, how much text was sent,
// how long the model spent reading it, how long until the first word came
// back, and whether anything was lost or repeated when the result was merged.
//
//   node scripts/bench-notes.js             what cue sends now
//   node scripts/bench-notes.js --legacy    the request shape cue used before:
//                                           2,048-token window, the whole notes
//                                           document resent, 900-token cap
//
// Options: --model <name>  --url <ollama url>  --ctx <tokens>
//
// It builds prompts and merges results with the same functions the app uses
// (src/notes.js), so the sizes and the merge outcome are the app's. --legacy
// reproduces the old request SHAPE only; the merge rules are always current.
// Needs Ollama running with at least one model pulled. Sends nothing anywhere
// except that Ollama server.

const {
  LIVE_NOTES_SYSTEM,
  buildLiveNotesPrompt,
  planNotesUpdate,
  mergeNotesSection,
  deduplicateBullets,
  notesBudget,
  notesOutputTokens
} = require('../src/notes');
const { resolveNotesLLM, DEFAULT_OLLAMA_URL } = require('../src/notes-engine');

const LEGACY_CONTEXT_TOKENS = 2048;
const LEGACY_OUTPUT_TOKENS = 900;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
// Same conservative ratio src/notes.js budgets with.
const CHARS_PER_TOKEN = 3.5;

// A design review, written the way speech-to-text delivers it: short turns,
// sentences split across fragments, decisions and owners mentioned in passing.
const MEETING = [
  ['them', 'Okay, let us get started. Today is about the schedule export service.'],
  ['them', 'Right now it writes every schedule as JSON to the shared drive'],
  ['them', 'and that drive fills up about once a month.'],
  ['you', 'How big are the files?'],
  ['them', 'Around 40 megabytes each, and we keep 90 days of them.'],
  ['them', 'So the proposal is to move the export to Azure Blob Storage.'],
  ['you', 'Hot tier or cool tier?'],
  ['them', 'Hot tier for the first 30 days, then a lifecycle rule moves them to cool.'],
  ['them', 'Priya has already tested the lifecycle rule in the dev subscription.'],
  ['you', 'Does the publish step still need the temporary file?'],
  ['them', 'Yes. The application writes to a temporary file first, then publishes.'],
  ['them', 'If publish fails we can resume with the dash L argument.'],
  ['you', 'And if it fails halfway through the upload?'],
  ['them', 'Then the temporary file is still there, so nothing is lost.'],
  ['them', 'Decision for today, we go with Blob Storage and keep the temporary file step.'],
  ['you', 'Agreed.'],
  ['them', 'Next topic is authentication between the scheduler and the gateway.'],
  ['them', 'We want mTLS on the gateway, terminated at the gateway itself.'],
  ['you', 'Who rotates the certificates?'],
  ['them', 'The platform team, every 60 days, through Key Vault.'],
  ['them', 'Marcus will write the rotation runbook by next Friday.'],
  ['you', 'Do we need a fallback if a certificate expires?'],
  ['them', 'There is a 7 day overlap where both certificates are valid.'],
  ['them', 'So an expired certificate should never take the gateway down.'],
  ['you', 'Okay. What about monitoring?'],
  ['them', 'We send gateway metrics to Datadog and alert on handshake failures.'],
  ['them', 'The threshold is more than 5 failures per minute for 3 minutes.'],
  ['you', 'That sounds reasonable.'],
  ['them', 'One more thing on the export. We are removing the raw dataframe output.'],
  ['them', 'Nobody reads it, and it doubles the size of every run.'],
  ['you', 'Does anything downstream depend on it?'],
  ['them', 'Only the old reconciliation script, and that is being retired in March.'],
  ['them', 'So action item, Dana removes the dataframe retention code this sprint.'],
  ['you', 'I can review that pull request.'],
  ['them', 'Great. Last topic is the test harness for the command line tool.'],
  ['them', 'The CLI testing script needs a Python environment with pytest and the Azure SDK.'],
  ['them', 'Right now everyone sets that up by hand and it drifts.'],
  ['you', 'Could we pin it with a lock file?'],
  ['them', 'Yes, we will add a requirements lock file and a setup script.'],
  ['them', 'Sam owns that, target is the end of the month.'],
  ['you', 'And the tests run in the pipeline too?'],
  ['them', 'They will, on every pull request, with a 10 minute timeout.'],
  ['them', 'I think that covers everything. Any open questions?'],
  ['you', 'Just the retention period for the cool tier.'],
  ['them', 'Good point. We said 90 days total, so 60 days in cool after the first 30.'],
  ['them', 'Thanks everyone.']
].map(([channel, text], index) => ({ channel, text, ts: index }));

// What a user does over a meeting: updates as speech comes in, an Insights
// click, two Questions clicks (the second must not repeat the first).
const SCENARIO = [
  { task: 'update', reveal: 12 },
  { task: 'update', reveal: 10 },
  { task: 'insights', reveal: 0 },
  { task: 'update', reveal: 10 },
  { task: 'questions', reveal: 0 },
  { task: 'update', reveal: 14 },
  { task: 'questions', reveal: 0 }
];

function parseArgs(argv) {
  const args = { legacy: false, model: '', url: '', ctx: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--legacy') args.legacy = true;
    else if (arg === '--model') args.model = argv[++i] || '';
    else if (arg === '--url') args.url = argv[++i] || '';
    else if (arg === '--ctx') args.ctx = Number(argv[++i]) || 0;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

const nanosToMs = (nanos) => (typeof nanos === 'number' ? Math.round(nanos / 1e6) : null);
const countBullets = (text) => String(text || '').split(/\r?\n/).filter((line) => /^\s*[-*•]\s+/.test(line)).length;

// Load the model with the window the requests will use, so the first request
// is not charged for a reload. Direct calls (here and below) rather than the
// app's client, because the app no longer allows the legacy 2,048-token window.
async function preloadModel({ baseUrl, model, contextTokens }) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({ model, messages: [], keep_alive: '30m', options: { num_ctx: contextTokens } })
  });
  await response.text();
}

// One streamed chat request, timed.
async function streamOllama({ baseUrl, model, system, prompt, contextTokens, maxTokens }) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      stream: true,
      keep_alive: '30m',
      options: { num_ctx: contextTokens, num_predict: maxTokens, temperature: 0.2 }
    })
  });
  if (!response.ok) throw new Error(`Ollama returned HTTP ${response.status} ${response.statusText}`);

  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let firstTokenMs = null;
  let final = {};
  const handleLine = (line) => {
    if (!line.trim()) return;
    let data;
    try { data = JSON.parse(line); } catch { return; }
    if (data.message && data.message.content) {
      if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
      text += data.message.content;
    }
    if (data.done) final = data;
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);

  return {
    text,
    firstTokenMs,
    totalMs: Math.round(performance.now() - startedAt),
    promptTokens: typeof final.prompt_eval_count === 'number' ? final.prompt_eval_count : null,
    promptEvalMs: nanosToMs(final.prompt_eval_duration),
    outputTokens: typeof final.eval_count === 'number' ? final.eval_count : null,
    evalMs: nanosToMs(final.eval_duration)
  };
}

function printTable(rows) {
  const columns = [
    ['#', (r) => r.step],
    ['task', (r) => r.task],
    ['prompt chars', (r) => r.promptChars],
    ['tokens read', (r) => r.promptTokens ?? '-'],
    ['read ms', (r) => r.promptEvalMs ?? '-'],
    ['first word ms', (r) => r.firstTokenMs ?? '-'],
    ['total ms', (r) => r.totalMs],
    ['out tokens', (r) => r.outputTokens ?? '-'],
    ['bullets', (r) => `${r.bulletsKept}/${r.bulletsGenerated}`],
    ['fits window', (r) => (r.fits ? 'yes' : 'NO')]
  ];
  const cells = [columns.map(([name]) => name), ...rows.map((row) => columns.map(([, get]) => String(get(row))))];
  const widths = columns.map((_, i) => Math.max(...cells.map((line) => line[i].length)));
  for (const line of cells) console.log(line.map((cell, i) => cell.padStart(widths[i])).join('  '));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/bench-notes.js [--legacy] [--model <name>] [--url <ollama url>] [--ctx <tokens>]');
    return 0;
  }

  const settings = {
    apiKeys: { ollama: args.url || DEFAULT_OLLAMA_URL },
    models: { ollama: { fast: args.model, smart: args.model } },
    notesContextTokens: args.ctx || undefined
  };
  const engine = await resolveNotesLLM(settings);
  if (!engine.ready) {
    console.error(engine.error);
    return 1;
  }
  if (args.model && !engine.ollamaModel.startsWith(args.model)) {
    console.error(`Model "${args.model}" is not installed in Ollama (found ${engine.ollamaModel}). Run: ollama pull ${args.model}`);
    return 1;
  }

  const budget = args.legacy
    ? { contextTokens: LEGACY_CONTEXT_TOKENS, maxNotesChars: 0, maxSpeechChars: 0, maxRewriteChars: Infinity }
    : notesBudget(settings.notesContextTokens);

  console.log(`mode      ${args.legacy ? 'legacy request shape' : 'current'}`);
  console.log(`model     ${engine.ollamaModel} at ${engine.ollamaBaseUrl}`);
  console.log(`window    ${budget.contextTokens} tokens`);
  console.log(`sends     ${budget.maxNotesChars ? `up to ${budget.maxNotesChars} chars of notes, ${budget.maxSpeechChars} of new speech` : 'the whole notes document and all new speech'}`);

  const loadStarted = performance.now();
  await preloadModel({ baseUrl: engine.ollamaBaseUrl, model: engine.ollamaModel, contextTokens: budget.contextTokens });
  console.log(`load      ${Math.round(performance.now() - loadStarted)} ms (model into memory; near zero if already loaded)\n`);

  let notes = '';
  let lastTurnIndex = 0;
  let revealed = 0;
  const rows = [];

  for (let step = 0; step < SCENARIO.length; step++) {
    const { task, reveal } = SCENARIO[step];
    revealed = Math.min(MEETING.length, revealed + reveal);
    const transcript = MEETING.slice(0, revealed);
    const plan = planNotesUpdate({ transcript, notes, lastTurnIndex, task, budget });
    const timeLabel = `1:${String(10 + step * 4).padStart(2, '0')} PM`;
    const prompt = buildLiveNotesPrompt({
      transcript: transcript.slice(0, plan.endIndex),
      previousNotes: notes,
      lastTurnIndex,
      task,
      timeLabel,
      maxNotesChars: budget.maxNotesChars,
      maxSpeechChars: budget.maxSpeechChars,
      appendOnly: plan.appendOnly
    });
    const maxTokens = args.legacy ? LEGACY_OUTPUT_TOKENS : notesOutputTokens(task, { rewrite: !plan.appends });

    process.stdout.write(`request ${step + 1}/${SCENARIO.length} (${task})… `);
    const result = await streamOllama({
      baseUrl: engine.ollamaBaseUrl,
      model: engine.ollamaModel,
      system: LIVE_NOTES_SYSTEM,
      prompt,
      contextTokens: budget.contextTokens,
      maxTokens
    });
    console.log(`${result.totalMs} ms`);

    const output = result.text.trim();
    const merged = output ? mergeNotesSection(notes, output, task, plan.appends) : notes;
    const bulletsGenerated = countBullets(output);
    const bulletsKept = plan.appends ? countBullets(merged) - countBullets(notes) : countBullets(merged);
    const promptChars = LIVE_NOTES_SYSTEM.length + prompt.length;
    rows.push({
      step: step + 1,
      task,
      promptChars,
      ...result,
      bulletsGenerated,
      bulletsKept,
      // Ollama cuts the prompt without an error when prompt + answer exceed the
      // window. Estimated from the prompt's size: once Ollama has cut a prompt,
      // the token count it reports is for what was left, not what was sent.
      fits: Math.ceil(promptChars / CHARS_PER_TOKEN) + maxTokens <= budget.contextTokens
    });
    notes = merged;
    if (task === 'update') lastTurnIndex = plan.endIndex;
  }

  console.log('');
  printTable(rows);

  // A bullet counts as repeated when it adds nothing to the notes before it.
  const lines = notes.split(/\r?\n/);
  let repeated = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*[-*•]\s+/.test(lines[i])) continue;
    const before = lines.slice(0, i).join('\n');
    if (before.trim() && deduplicateBullets(before, lines[i].trim()) === '') repeated += 1;
  }
  const sum = (key) => rows.reduce((total, row) => total + (row[key] || 0), 0);
  const overflow = rows.filter((row) => row.fits === false).length;

  console.log('');
  console.log(`time to first word, all requests   ${sum('firstTokenMs')} ms`);
  console.log(`time reading prompts, all requests ${sum('promptEvalMs')} ms`);
  console.log(`total time, all requests           ${sum('totalMs')} ms`);
  console.log(`requests that overflowed the window ${overflow} of ${rows.length}${overflow ? '  <- Ollama truncated these prompts without reporting it' : ''}`);
  console.log(`final notes                        ${notes.length} chars, ${countBullets(notes)} bullets, ${repeated} repeated`);
  console.log(`bullets the model wrote / kept     ${sum('bulletsGenerated')} / ${sum('bulletsKept')} (the difference was dropped as already noted)`);
  console.log('\n"tokens read" and "read ms" are Ollama\'s own figures for evaluating the prompt. They are low on');
  console.log('repeat requests when the start of the prompt is unchanged, because Ollama reuses it from the');
  console.log(`previous request. "fits window" is estimated at ${CHARS_PER_TOKEN} characters per token.`);
  return 0;
}

main().then((code) => { process.exitCode = code; }).catch((error) => {
  console.error(`bench-notes failed: ${error && error.message ? error.message : error}`);
  process.exitCode = 1;
});
