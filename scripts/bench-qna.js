#!/usr/bin/env node
// QnA benchmark: replays one short typed `ask` through cue's own LLM path
// (src/llm.js createLLM + src/prompts.js MODES.ask + interview context) and
// reports, per model, time to first token, total time, and token counts.
//
//   node scripts/bench-qna.js --dry-run     no API calls: measures only the
//                                           local prompt assembly + LLM
//                                           factory setup, so $0 spend.
//   GEMINI_API_KEY=... node scripts/bench-qna.js
//                                           live run, cheap by default:
//                                           5 configs x 1 timed run, short
//                                           fixture, maxTokens 1400 (cue's
//                                           fast-tier cap). Do NOT lower the
//                                           cap below ~1000: maxOutputTokens
//                                           is shared between thinking and
//                                           visible output, and Hydrogen at
//                                           LOW spends ~300-460 thinking
//                                           tokens first, so a 300 cap leaves
//                                           almost nothing for the answer.
//                                           At Hydrogen rates ($1.50/$7.50
//                                           per 1M tokens) the default run
//                                           is roughly $0.05 total. Pass
//                                           --reps 2 for a median, roughly
//                                           double that.
//
// The first run per model is cache-cold; the timed run reuses the implicit
// prompt cache, the same way a second ask in a real meeting does. No
// screenshot is sent: this is the typed-ask path, where the screen is
// skipped unless the question references it (main.js runFeature).

const { createLLM, geminiThinkingConfig } = require('../src/llm');
const { MODES } = require('../src/prompts');
const { buildInterviewContextParts } = require('../src/interview-context');

// Short, representative fixture. Deliberately small: the point is model
// latency at a given thinking level, not prompt size. The full-size prompt
// (8k doc + 12k resume) is already covered by CUE_PERF=1 in the app.
const TRANSCRIPT = [
  { channel: 'them', text: 'Today is about the schedule export service. It writes every schedule as JSON to the shared drive, and that drive fills up about once a month.' },
  { channel: 'you', text: 'How big are the files?' },
  { channel: 'them', text: 'Around 40 megabytes each, and we keep 90 days of them. The proposal is to move the export to Azure Blob Storage, hot tier for 30 days, then cool.' },
  { channel: 'them', text: 'Priya tested the lifecycle rule in dev. If publish fails we can resume with the dash L argument.' }
];
const USER_TEXT = 'What is the main tradeoff of moving the schedule export to Azure Blob Storage?';
const SETTINGS = {
  resumeText: 'Software engineer, 2 years. Built a schedule export service in Python, moved it from local disk to Azure Blob Storage, cut storage cost by 40%.',
  jobDescription: 'Software Engineer, backend services and cloud storage.',
  starStories: '',
  whyCompany: '',
  whyLeaving: '',
  workStyle: '',
  salaryTarget: '',
  questionsToAsk: '',
  contextDoc: 'Schedule export: 40 MB JSON files, 90-day retention, publish step writes a temp file first, resume with -L on failure.'
};

// model, tier, and the thinking level cue will send for it. Keep this in
// sync with src/llm.js: the bench reads the level from geminiThinkingConfig
// instead of hardcoding it, so a config regression shows up here first.
const CONFIGS = [
  { label: 'gemini-3.5-flash-lite fast', model: 'gemini-3.5-flash-lite', smart: false },
  { label: 'gemini-3.8-flash fast', model: 'gemini-3.8-flash', smart: false },
  { label: 'gemini-3.8-flash smart', model: 'gemini-3.8-flash', smart: true },
  { label: 'gemini-4-hydrogen fast', model: 'gemini-4-hydrogen', smart: false },
  { label: 'gemini-4-hydrogen smart', model: 'gemini-4-hydrogen', smart: true }
];

function parseArgs(argv) {
  const out = { dryRun: false, reps: 1, configs: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true;
    else if (argv[i] === '--reps') out.reps = Math.max(1, Number(argv[++i]) || 1);
    else if (argv[i] === '--only') out.configs = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

function buildAsk(settings) {
  const started = performance.now();
  const contextParts = buildInterviewContextParts(settings, 'ask', TRANSCRIPT, USER_TEXT);
  const system = MODES.ask.buildSystem(contextParts, '', settings);
  const built = MODES.ask.build({ transcript: TRANSCRIPT, userText: USER_TEXT, chatHistory: [] });
  return { system, built, assemblyMs: performance.now() - started };
}

async function runOnce(llm, system, built, maxTokens) {
  let firstTokenMs = null;
  let usage = null;
  const started = performance.now();
  const text = await llm.stream({
    system,
    turns: [{ role: 'user', text: built }],
    mode: 'ask',
    maxTokens,
    onToken: () => { if (firstTokenMs === null) firstTokenMs = performance.now() - started; },
    onUsage: (u) => { usage = u; }
  });
  return { firstTokenMs: Math.round(firstTokenMs ?? -1), totalMs: Math.round(performance.now() - started), chars: text.length, usage };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!opts.dryRun && !apiKey) {
    console.error('Set GEMINI_API_KEY to run live, or pass --dry-run for the $0 local check.');
    process.exit(2);
  }

  // Local assembly first: this is the part of QnA cue controls directly,
  // and it costs nothing to measure.
  const { system, built, assemblyMs } = buildAsk(SETTINGS);
  console.log(`prompt: system_chars=${system.length} user_chars=${built.length} assembly_ms=${assemblyMs.toFixed(1)}`);
  for (const cfg of CONFIGS) {
    console.log(`${cfg.label}: thinking=${JSON.stringify(geminiThinkingConfig(cfg.model, 'ask', cfg.smart))}`);
  }
  if (opts.dryRun) {
    console.log('dry-run done: no API calls made.');
    return;
  }

  const configs = opts.configs
    ? CONFIGS.filter((c) => opts.configs.some((s) => c.label.includes(s)))
    : CONFIGS;
  if (!configs.length) { console.error('No configs matched --only.'); process.exit(2); }

  for (const cfg of configs) {
    const llm = createLLM({
      provider: 'gemini',
      smart: cfg.smart,
      apiKeys: { gemini: apiKey },
      models: { gemini: { fast: cfg.model, smart: cfg.model, quick: '' } }
    });
    if (!llm.ready) { console.log(`${cfg.label}: not ready (${llm.configurationError})`); continue; }
    // One cache-cold run, discarded from the timing, so the timed run
    // measures the warm-cache path a real second ask takes.
    try { await runOnce(llm, system, built, 1400); } catch (e) { console.log(`${cfg.label}: warmup failed: ${e.message}`); continue; }
    const runs = [];
    for (let i = 0; i < opts.reps; i++) {
      try { runs.push(await runOnce(llm, system, built, 1400)); }
      catch (e) { console.log(`${cfg.label}: run ${i + 1} failed: ${e.message}`); }
    }
    for (const r of runs) {
      const u = r.usage || {};
      console.log(`${cfg.label}: first_token=${r.firstTokenMs}ms total=${r.totalMs}ms chars=${r.chars} prompt_tokens=${u.promptTokens ?? '?'} cached_tokens=${u.cachedTokens ?? '?'} output_tokens=${u.outputTokens ?? '?'} thought_tokens=${u.thoughtTokens ?? '?'}`);
    }
  }
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
