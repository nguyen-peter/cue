const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { CURRENT_GEMINI_DEFAULT, CURRENT_GEMINI_SMART_DEFAULT, DEFAULT_MODELS, DEFAULT_SMART_MODELS, createLLM } = require('../src/llm');

// Google retired gemini-2.0-flash on 2026-03-03 (deprecated Feb 2026); every
// request against it 404s with a generic "exception parsing response" body —
// this is the root cause behind the cluster of "Error: got status: 404"
// bug reports. Before the fix, four different files each hardcoded their own
// Gemini model id (two still pointing at the dead one), so this scans every
// source file that talks to the Gemini API and fails if a known-retired id
// or a hardcoded id that has drifted from the shared default sneaks back in.
//
// gemini-2.5-flash joined the list in Nov 2026: Google deprecated it, limits
// it to accounts that already used it, and reroutes it to 3.5 Flash-Lite from
// 2026-12-01. (gemini-2.5-flash-lite is not deprecated.)
const DEAD_MODEL_IDS = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-1.0-pro'];

const FILES_THAT_CALL_GEMINI = [
  'src/llm.js',
  'src/store.js',
  'src/stt.js',
  'src/stt-streaming.js'
];

test('CURRENT_GEMINI_DEFAULT is not a known-retired Gemini model id', () => {
  assert.ok(!DEAD_MODEL_IDS.includes(CURRENT_GEMINI_DEFAULT), `${CURRENT_GEMINI_DEFAULT} is on the known-dead list`);
});

for (const relPath of FILES_THAT_CALL_GEMINI) {
  test(`${relPath} does not hardcode a retired Gemini model id`, () => {
    const source = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
    for (const deadId of DEAD_MODEL_IDS) {
      assert.ok(!source.includes(`'${deadId}'`) && !source.includes(`"${deadId}"`),
        `${relPath} still references retired model ${deadId}`);
    }
  });
}

test('store.js default Gemini models match the shared current defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/store.js'), 'utf8');
  const match = /gemini:\s*\{\s*fast:\s*'([^']+)',\s*smart:\s*'([^']+)'/.exec(source);
  assert.ok(match, 'could not find the gemini default models block in store.js');
  assert.equal(match[1], CURRENT_GEMINI_DEFAULT);
  assert.equal(match[2], CURRENT_GEMINI_SMART_DEFAULT);
});

test('store.js default Anthropic models match the shared current defaults', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/store.js'), 'utf8');
  const match = /anthropic:\s*\{\s*fast:\s*'([^']+)',\s*smart:\s*'([^']+)'/.exec(source);
  assert.ok(match, 'could not find the anthropic default models block in store.js');
  assert.equal(match[1], DEFAULT_MODELS.anthropic);
  assert.equal(match[2], DEFAULT_SMART_MODELS.anthropic);
});

test('a settings file still holding gemini-2.5-flash is moved to the current default for its tier', () => {
  const saved = { provider: 'gemini', apiKeys: { gemini: 'k' }, models: { gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' } } };
  assert.equal(createLLM({ ...saved, smart: false }).model, CURRENT_GEMINI_DEFAULT);
  assert.equal(createLLM({ ...saved, smart: true }).model, CURRENT_GEMINI_SMART_DEFAULT);
});

test('gemini-2.5-flash-lite is not deprecated and is left alone', () => {
  const llm = createLLM({ provider: 'gemini', smart: false, apiKeys: { gemini: 'k' }, models: { gemini: { fast: 'gemini-2.5-flash-lite', smart: 'gemini-2.5-flash-lite' } } });
  assert.equal(llm.model, 'gemini-2.5-flash-lite');
});

test('retired Claude 3.x ids saved in settings are replaced; current ids are kept', () => {
  const saved = (fast, smart) => ({ provider: 'anthropic', apiKeys: { anthropic: 'k' }, models: { anthropic: { fast, smart } } });
  const retired = saved('claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest');
  assert.equal(createLLM({ ...retired, smart: false }).model, DEFAULT_MODELS.anthropic);
  assert.equal(createLLM({ ...retired, smart: true }).model, DEFAULT_SMART_MODELS.anthropic);
  assert.equal(createLLM({ ...saved('claude-opus-4-8', 'claude-opus-4-8'), smart: false }).model, 'claude-opus-4-8');
});
