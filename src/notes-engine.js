// The local model that writes Notes. Notes mode never spends a cloud API key:
// it only ever talks to an Ollama server (on this machine by default, or
// wherever the Ollama URL in Settings points).
//
// No Electron dependency, so scripts/bench-notes.js can use the same code path
// as the app.

const { createLLM } = require('./llm');
const { normalizeNotesContextTokens } = require('./notes');

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const PROBE_TIMEOUT_MS = 900;

const PREFERRED_OLLAMA_MODELS = [
  'qwen2.5:7b',
  'qwen2.5:3b',
  'llama3.1:8b',
  'llama3.2:3b',
  'llama3.2',
  'llama3.1',
  'qwen2.5',
  'gemma2',
  'mistral'
];

function ollamaBaseUrl(settings) {
  return ((settings.apiKeys && settings.apiKeys.ollama) || DEFAULT_OLLAMA_URL).replace(/\/$/, '');
}

function configuredNotesModel(settings) {
  return (settings.models && settings.models.ollama && settings.models.ollama.fast) || '';
}

function matchesModel(installedName, wanted) {
  return installedName === wanted || installedName === `${wanted}:latest` || installedName.startsWith(`${wanted}:`);
}

// Ask Ollama what is installed and pick a model: the one configured in
// Settings if present, else the first preferred one, else whatever is there.
// Returns null when Ollama cannot be reached.
async function probeLocalOllamaModel(settings, { fetchImpl = fetch } = {}) {
  const baseUrl = ollamaBaseUrl(settings);
  try {
    const res = await fetchImpl(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    const installed = Array.isArray(data && data.models)
      ? data.models.map((m) => m && m.name).filter((n) => typeof n === 'string' && !/embed/i.test(n))
      : [];
    if (!installed.length) return { running: true, model: null, baseUrl };

    const configured = configuredNotesModel(settings);
    if (configured) {
      const match = installed.find((n) => matchesModel(n, configured));
      if (match) return { running: true, model: match, baseUrl };
    }
    for (const preferred of PREFERRED_OLLAMA_MODELS) {
      const match = installed.find((n) => matchesModel(n, preferred));
      if (match) return { running: true, model: match, baseUrl };
    }
    return { running: true, model: installed[0], baseUrl };
  } catch (_) {
    return null;
  }
}

// Load the model into memory ahead of the first request. The context size
// must be the one the real requests will use: Ollama reloads the model when a
// request asks for a different size, which would undo the preload.
function preloadLocalOllamaModel(baseUrl, model, contextTokens, { fetchImpl = fetch } = {}) {
  if (!baseUrl || !model) return Promise.resolve();
  return fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [],
      keep_alive: '30m',
      options: { num_ctx: normalizeNotesContextTokens(contextTokens) }
    })
  }).then(() => {}).catch(() => {});
}

async function resolveNotesLLM(settings, deps) {
  // Notes Mode uses 100% Free Local Ollama exclusively (never consumes cloud API keys)
  const probe = await probeLocalOllamaModel(settings, deps);
  if (probe && probe.model) {
    const ollamaSettings = {
      provider: 'ollama',
      smart: false,
      quick: false,
      notesContextTokens: normalizeNotesContextTokens(settings.notesContextTokens),
      apiKeys: { ollama: probe.baseUrl },
      models: {
        ollama: { fast: probe.model, smart: probe.model }
      }
    };
    return {
      llm: createLLM(ollamaSettings),
      label: `Ollama · ${probe.model} (Free Local)`,
      isLocal: true,
      ready: true,
      ollamaBaseUrl: probe.baseUrl,
      ollamaModel: probe.model,
      contextTokens: ollamaSettings.notesContextTokens
    };
  }

  if (probe && probe.running) {
    return {
      llm: { ready: false },
      label: 'Ollama (No model — run `ollama pull qwen2.5:7b`)',
      isLocal: true,
      ready: false,
      error: 'Ollama is running, but no local model was found. Run: ollama pull qwen2.5:7b'
    };
  }

  return {
    llm: { ready: false },
    label: 'Ollama offline (Free Local LLM)',
    isLocal: true,
    ready: false,
    error: 'Local Ollama is offline. Start the Ollama application on your PC to generate free notes.'
  };
}

/**
 * Remembers the engine found by the last successful probe, so each notes
 * update does not start with a round trip to list Ollama's models. Only a
 * working engine is remembered; a failure is always re-checked. Call
 * invalidate() when a request fails or Settings change.
 */
function createNotesEngine(deps) {
  let cached = null;
  const keyFor = (settings) => [
    ollamaBaseUrl(settings),
    configuredNotesModel(settings),
    normalizeNotesContextTokens(settings.notesContextTokens)
  ].join('|');

  return {
    async resolve(settings) {
      const key = keyFor(settings);
      if (cached && cached.key === key) return cached.value;
      const value = await resolveNotesLLM(settings, deps);
      cached = value.ready ? { key, value } : null;
      return value;
    },
    invalidate() { cached = null; }
  };
}

module.exports = {
  DEFAULT_OLLAMA_URL,
  PREFERRED_OLLAMA_MODELS,
  probeLocalOllamaModel,
  preloadLocalOllamaModel,
  resolveNotesLLM,
  createNotesEngine
};
