// The local Ollama engine behind Notes: which model is chosen, that the probe
// result is reused for the session, and that the preload asks for the same
// context size the requests will use.

const assert = require('node:assert/strict');
const test = require('node:test');
const { probeLocalOllamaModel, preloadLocalOllamaModel, resolveNotesLLM, createNotesEngine } = require('../src/notes-engine');

function tagsFetch(names, calls = []) {
  return async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ models: names.map((name) => ({ name })) }) };
  };
}

const settings = (overrides = {}) => ({ apiKeys: { ollama: 'http://127.0.0.1:59100/' }, models: { ollama: { fast: '' } }, ...overrides });

test('the model configured in Settings wins when it is installed', async () => {
  const probe = await probeLocalOllamaModel(
    settings({ models: { ollama: { fast: 'phi4' } } }),
    { fetchImpl: tagsFetch(['llama3.2:3b', 'phi4:latest']) }
  );
  assert.deepEqual(probe, { running: true, model: 'phi4:latest', baseUrl: 'http://127.0.0.1:59100' });
});

test('otherwise the first preferred model is used, never an embedding model', async () => {
  const preferred = await probeLocalOllamaModel(settings(), { fetchImpl: tagsFetch(['nomic-embed-text:latest', 'mistral:7b', 'qwen2.5:7b']) });
  assert.equal(preferred.model, 'qwen2.5:7b');
  const onlyUnknown = await probeLocalOllamaModel(settings(), { fetchImpl: tagsFetch(['nomic-embed-text:latest', 'some-model:1b']) });
  assert.equal(onlyUnknown.model, 'some-model:1b');
});

test('Ollama running with nothing pulled, and Ollama unreachable, are told apart', async () => {
  const empty = await resolveNotesLLM(settings(), { fetchImpl: tagsFetch([]) });
  assert.equal(empty.ready, false);
  assert.match(empty.error, /no local model was found/);

  const offline = await resolveNotesLLM(settings(), { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(offline.ready, false);
  assert.match(offline.error, /offline/);
});

test('a ready engine carries the context size the requests will use', async () => {
  const engine = await resolveNotesLLM(settings({ notesContextTokens: 8192 }), { fetchImpl: tagsFetch(['qwen2.5:7b']) });
  assert.equal(engine.ready, true);
  assert.equal(engine.ollamaModel, 'qwen2.5:7b');
  assert.equal(engine.contextTokens, 8192);
  assert.equal(engine.llm.provider, 'ollama');
  assert.equal(engine.llm.ready, true);

  const defaulted = await resolveNotesLLM(settings(), { fetchImpl: tagsFetch(['qwen2.5:7b']) });
  assert.equal(defaulted.contextTokens, 4096);
});

test('the preload asks for the same context size, so Ollama does not reload the model', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  await preloadLocalOllamaModel('http://127.0.0.1:59100/', 'qwen2.5:7b', 8192, { fetchImpl });
  await preloadLocalOllamaModel('http://127.0.0.1:59100', 'qwen2.5:7b', undefined, { fetchImpl });
  assert.equal(calls[0].url, 'http://127.0.0.1:59100/api/chat');
  assert.equal(calls[0].body.options.num_ctx, 8192);
  assert.deepEqual(calls[0].body.messages, []);
  assert.equal(calls[1].body.options.num_ctx, 4096);
  // A failed preload must never surface: it is only a head start.
  await preloadLocalOllamaModel('http://127.0.0.1:59100', 'qwen2.5:7b', 4096, { fetchImpl: async () => { throw new Error('down'); } });
});

test('the engine is looked up once per session, not once per update', async () => {
  const calls = [];
  const engine = createNotesEngine({ fetchImpl: tagsFetch(['qwen2.5:7b'], calls) });
  const first = await engine.resolve(settings());
  const second = await engine.resolve(settings());
  assert.equal(calls.length, 1);
  assert.equal(second, first);

  engine.invalidate();
  await engine.resolve(settings());
  assert.equal(calls.length, 2, 'after a failure or a settings change it is checked again');
});

test('a different Ollama URL, model or context size is a different engine', async () => {
  const calls = [];
  const engine = createNotesEngine({ fetchImpl: tagsFetch(['qwen2.5:7b', 'phi4:latest'], calls) });
  await engine.resolve(settings());
  await engine.resolve(settings({ notesContextTokens: 8192 }));
  await engine.resolve(settings({ notesContextTokens: 8192, models: { ollama: { fast: 'phi4' } } }));
  await engine.resolve(settings({ notesContextTokens: 8192, models: { ollama: { fast: 'phi4' } }, apiKeys: { ollama: 'http://127.0.0.1:59101' } }));
  assert.equal(calls.length, 4);
});

test('an unavailable engine is never remembered', async () => {
  let online = false;
  const calls = [];
  const engine = createNotesEngine({
    fetchImpl: async (url, init) => {
      calls.push(url);
      if (!online) throw new Error('ECONNREFUSED');
      return tagsFetch(['qwen2.5:7b'])(url, init);
    }
  });
  assert.equal((await engine.resolve(settings())).ready, false);
  online = true;
  assert.equal((await engine.resolve(settings())).ready, true, 'starting Ollama is picked up on the next try');
  assert.equal(calls.length, 2);
});
