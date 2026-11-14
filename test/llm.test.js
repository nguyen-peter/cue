const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');
const { OPTIONAL_API_KEY_PLACEHOLDER } = require('../src/openai-compatible');

let capturedClientOptions = null;
let capturedCompletionRequest = null;
let capturedGeminiRequest = null;
let capturedAnthropicRequest = null;
// Per-test scripted Gemini responses: each entry handles one call, then the
// default "ok" stream takes over.
let geminiScript = [];
let geminiCalls = 0;
// Per-test scripted Anthropic stream events; null = the default single "ok".
let anthropicEvents = null;
const originalModuleLoad = Module._load;

Module._load = function loadWithProviderStubs(request, parent, isMain) {
  if (request === 'openai') {
    return class FakeOpenAI {
      constructor(clientOptions) {
        capturedClientOptions = clientOptions;
        this.chat = {
          completions: {
            create: async (completionRequest) => {
              capturedCompletionRequest = completionRequest;
              return [{ choices: [{ delta: { content: 'ok' } }] }];
            }
          }
        };
      }
    };
  }
  if (request === '@google/genai') {
    return {
      GoogleGenAI: class FakeGoogleGenAI {
        constructor() {
          this.models = {
            generateContentStream: async (generateRequest) => {
              capturedGeminiRequest = generateRequest;
              geminiCalls++;
              const scripted = geminiScript.shift();
              if (scripted) return scripted(generateRequest);
              return (async function* () { yield { text: 'ok' }; })();
            }
          };
        }
      }
    };
  }
  if (request === '@anthropic-ai/sdk') {
    return class FakeAnthropic {
      constructor() {
        this.messages = {
          create: async (messageRequest) => {
            capturedAnthropicRequest = messageRequest;
            const events = anthropicEvents || [{ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } }];
            return (async function* () {
              for (const event of events) yield event;
            })();
          }
        };
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createLLM, formatProviderErrorMessage, isQuotaError, isOverloadedError, CURRENT_GEMINI_DEFAULT, CURRENT_GEMINI_SMART_DEFAULT, FETCH_WARMUP_TTL_MS, isReasoningChatModel, tokenBudget, geminiThinkingConfig } = require('../src/llm');

test.after(() => {
  Module._load = originalModuleLoad;
});

function createCustomSettings(overrides = {}) {
  return {
    provider: 'custom',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { custom: 'gateway-token' },
    models: { custom: { fast: 'openclaw/default', smart: 'openclaw/default' } },
    ...overrides
  };
}

test.beforeEach(() => {
  capturedClientOptions = null;
  capturedCompletionRequest = null;
  capturedGeminiRequest = null;
  capturedAnthropicRequest = null;
  geminiScript = [];
  geminiCalls = 0;
  anthropicEvents = null;
});

test('routes the Custom provider through the configured OpenAI-compatible endpoint', async () => {
  const receivedTokens = [];
  const llm = createLLM(createCustomSettings());

  assert.equal(llm.ready, true);
  assert.equal(llm.model, 'openclaw/default');

  const response = await llm.stream({
    system: 'Be concise.',
    turns: [{ role: 'user', text: 'Hello' }],
    onToken: (token) => receivedTokens.push(token)
  });

  assert.equal(capturedClientOptions.apiKey, 'gateway-token');
  assert.equal(capturedClientOptions.baseURL, 'http://127.0.0.1:18789/v1');
  assert.ok(capturedClientOptions.httpAgent, 'clients carry the shared keep-alive agent');
  assert.equal(capturedCompletionRequest.model, 'openclaw/default');
  assert.equal(response, 'ok');
  assert.deepEqual(receivedTokens, ['ok']);
});

test('allows an unauthenticated local Custom endpoint', async () => {
  const llm = createLLM(createCustomSettings({ apiKeys: { custom: '' } }));
  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, OPTIONAL_API_KEY_PLACEHOLDER);
});

test('does not apply the Custom Base URL to official OpenAI requests', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    baseUrl: 'http://127.0.0.1:18789/v1',
    apiKeys: { openai: 'official-openai-key' },
    models: { openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' } }
  });

  await llm.stream({ system: '', turns: [], onToken: () => {} });

  assert.equal(capturedClientOptions.apiKey, 'official-openai-key');
  assert.equal(capturedClientOptions.baseURL, undefined);
  assert.ok(capturedClientOptions.httpAgent, 'clients carry the shared keep-alive agent');
});

test('reports incomplete Custom endpoint settings without making a request', () => {
  const llm = createLLM(createCustomSettings({ baseUrl: '' }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Base URL/);
  assert.equal(capturedClientOptions, null);
});

test('requires a model for the Custom provider', () => {
  const llm = createLLM(createCustomSettings({
    models: { custom: { fast: '', smart: '' } }
  }));

  assert.equal(llm.ready, false);
  assert.match(llm.configurationError, /Set a Fast or Smart model/);
});

// ---- MiniMax (PR #22) -----------------------------------------------------
// MiniMax is OpenAI-compatible and region-split, so these assert the regional
// gateway selection rather than any new transport.

function minimaxSettings(overrides) {
  return Object.assign({
    provider: 'minimax',
    smart: true,
    apiKeys: { minimax: 'test-key' },
    models: { minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' } }
  }, overrides || {});
}

test('selects the MiniMax model for the active tier and reports readiness', () => {
  const smart = createLLM(minimaxSettings({ smart: true }));
  assert.equal(smart.provider, 'minimax');
  assert.equal(smart.model, 'MiniMax-M3');
  assert.equal(smart.ready, true);

  const fast = createLLM(minimaxSettings({ smart: false }));
  assert.equal(fast.model, 'MiniMax-M2.7');
});

test('routes MiniMax to the global OpenAI-compatible endpoint by default', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'global_en' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
  assert.equal(capturedClientOptions.apiKey, 'test-key');
});

test('routes MiniMax to the China endpoint when that region is selected', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'cn_zh' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimaxi.com/v1');
});

test('falls back to the global endpoint for an unknown region', async () => {
  capturedClientOptions = null;
  const llm = createLLM(minimaxSettings({ minimaxRegion: 'unknown' }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedClientOptions.baseURL, 'https://api.minimax.io/v1');
});

// ---- Gemini 404/429 error mapping ------------------------------------------
// Reproduces the exact bug-report clusters: "Error: got status: 404 Not Found.
// {"error":{"message":"exception parsing response","code":404,"status":"Not
// Found"}}" (dead/misspelled model) and 429 quota exhaustion, and asserts they
// come out as actionable in-app messages instead of the raw provider JSON.

function geminiApiError({ status, body }) {
  const err = new Error(`got status: ${status}. ${JSON.stringify(body)}`);
  err.name = 'ApiError';
  err.status = status; // matches @google/genai's ApiError shape
  return err;
}

test('formatProviderErrorMessage: maps a Gemini 404 to an actionable "model unavailable" message', () => {
  const error = geminiApiError({
    status: 404,
    body: { error: { message: 'exception parsing response', code: 404, status: 'Not Found' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.0-flash');
  assert.match(message, /Gemini/);
  assert.match(message, /model "gemini-2\.0-flash"/);
  assert.match(message, /unavailable \(404\)/);
  assert.match(message, /Settings/);
  assert.doesNotMatch(message, /exception parsing response/);
});

test('formatProviderErrorMessage: 404 message still works without a model id', () => {
  const error = geminiApiError({ status: 404, body: { error: { message: 'not found', code: 404 } } });
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI model is unavailable \(404\)/);
});

test('formatProviderErrorMessage: maps a Gemini 429 to a free-tier quota message', () => {
  const error = geminiApiError({
    status: 429,
    body: { error: { message: 'You exceeded your current quota', code: 429, status: 'RESOURCE_EXHAUSTED' } }
  });
  const message = formatProviderErrorMessage(error, 'gemini', 'gemini-2.5-flash');
  assert.match(message, /Gemini free-tier quota exhausted \(429/);
  assert.match(message, /billing/);
  assert.doesNotMatch(message, /RESOURCE_EXHAUSTED/);
});

test('formatProviderErrorMessage: surfaces retry-after when the 429 body carries a RetryInfo delay', () => {
  const error = geminiApiError({
    status: 429,
    body: {
      error: {
        message: 'Resource exhausted',
        code: 429,
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '38s' }]
      }
    }
  });
  const message = formatProviderErrorMessage(error, 'gemini');
  assert.match(message, /Wait about 38s/);
});

test('formatProviderErrorMessage: 429 without a retry delay falls back to a generic wait hint', () => {
  const error = new Error('429 Too Many Requests');
  error.status = 429;
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /Wait a moment/);
});

test('formatProviderErrorMessage: an OpenAI-style quota 429 (no numeric status) is still recognized', () => {
  // Matches the literal text one of the bug reports pasted in.
  const error = new Error('429 You exceeded your current quota, please check your plan and billing details.');
  const message = formatProviderErrorMessage(error, 'openai');
  assert.match(message, /OpenAI free-tier quota exhausted/);
});

test('formatProviderErrorMessage: an unrecognized error passes its raw message through unchanged', () => {
  const error = new Error('socket hang up');
  assert.equal(formatProviderErrorMessage(error, 'anthropic'), 'socket hang up');
});

test('isQuotaError: agrees with formatProviderErrorMessage on what counts as quota', () => {
  assert.equal(isQuotaError(geminiApiError({ status: 429, body: {} })), true);
  assert.equal(isQuotaError(geminiApiError({ status: 404, body: {} })), false);
  assert.equal(isQuotaError(new Error('insufficient_quota')), true);
});

// ---- Gemini model selection / self-healing migration -----------------------

function geminiSettings(overrides) {
  return Object.assign({
    provider: 'gemini',
    smart: false,
    apiKeys: { gemini: 'test-key' }
  }, overrides || {});
}

test('createLLM: falls back to CURRENT_GEMINI_DEFAULT when no model is configured', () => {
  const llm = createLLM(geminiSettings({ models: {} }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
  assert.equal(llm.ready, true);
});

test('createLLM: a fresh install (store.js DEFAULTS shape) resolves to the current defaults', () => {
  const models = { gemini: { fast: CURRENT_GEMINI_DEFAULT, smart: CURRENT_GEMINI_SMART_DEFAULT } };
  assert.equal(createLLM(geminiSettings({ models })).model, CURRENT_GEMINI_DEFAULT);
  assert.equal(createLLM(geminiSettings({ models, smart: true })).model, CURRENT_GEMINI_SMART_DEFAULT);
});

test('createLLM: self-heals a settings file saved with the retired gemini-2.0-flash default', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.0-flash' } }
  }));
  assert.equal(llm.model, CURRENT_GEMINI_DEFAULT);
});

test('createLLM: self-heals a legacy gemini-1.5-* model saved before the 2.0-flash migration existed', () => {
  const models = { gemini: { fast: 'gemini-1.5-flash', smart: 'gemini-1.5-pro' } };
  assert.equal(createLLM(geminiSettings({ models })).model, CURRENT_GEMINI_DEFAULT);
  // The replacement follows the tier the dead id was saved under.
  assert.equal(createLLM(geminiSettings({ models, smart: true })).model, CURRENT_GEMINI_SMART_DEFAULT);
});

test('createLLM: leaves a user-chosen current Gemini model alone', () => {
  const llm = createLLM(geminiSettings({
    models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } }
  }));
  assert.equal(llm.model, 'gemini-3.5-flash');
});

// ---- latency optimizations ---------------------------------------------------

test('official OpenAI requests use max_completion_tokens (reasoning-model compatible)', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'k' },
    models: {}
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.equal(capturedCompletionRequest.max_completion_tokens, tokenBudget('ask', false));
  assert.equal(capturedCompletionRequest.max_tokens, undefined);
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined, 'gpt-4o-mini must not receive reasoning_effort');
});

test('OpenAI-compatible endpoints keep the widely supported max_tokens param', async () => {
  const llm = createLLM(createCustomSettings());
  await llm.stream({ system: '', turns: [], onToken: () => {} });
  assert.equal(capturedCompletionRequest.max_tokens, tokenBudget(undefined, false));
  assert.equal(capturedCompletionRequest.max_completion_tokens, undefined);
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined);
});

test('isReasoningChatModel matches GPT-5 and o-series ids only', () => {
  assert.equal(isReasoningChatModel('gpt-5.4-mini'), true);
  assert.equal(isReasoningChatModel('gpt-5.4'), true);
  assert.equal(isReasoningChatModel('o3-mini'), true);
  assert.equal(isReasoningChatModel('gpt-4o-mini'), false);
  assert.equal(isReasoningChatModel('gpt-4.1'), false);
  assert.equal(isReasoningChatModel(''), false);
});

test('GPT-5 fast-tier conversational requests send reasoning_effort low', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4-mini', smart: 'gpt-5.4' } }
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedCompletionRequest.reasoning_effort, 'low');
});

test('GPT-5 keeps full reasoning on Smart tier and LeetCode', async () => {
  const smart = createLLM({
    provider: 'openai',
    smart: true,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4-mini', smart: 'gpt-5.4' } }
  });
  await smart.stream({ system: '', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined);

  const fastLc = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4-mini', smart: 'gpt-5.4' } }
  });
  await fastLc.stream({ system: '', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedCompletionRequest.reasoning_effort, undefined);
});

const QUICK_SPLIT = { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash', quick: 'gemini-3.5-flash-lite' } };

test('Quick mode sends Quick-prompt modes to the Quick model', async () => {
  const llm = createLLM(geminiSettings({ quick: true, models: QUICK_SPLIT }));
  for (const mode of ['ask', 'say', 'assist', 'answerThis']) {
    assert.equal(llm.modelFor(mode), 'gemini-3.5-flash-lite');
    await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode, onToken: () => {} });
    assert.equal(capturedGeminiRequest.model, 'gemini-3.5-flash-lite');
  }
  // Flash-Lite's own thinking level, not the one picked for the main model.
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'MINIMAL', includeThoughts: true });
});

test('Quick model never handles LeetCode, followups or recaps', async () => {
  const llm = createLLM(geminiSettings({ quick: true, models: QUICK_SPLIT }));
  for (const mode of ['leetcode', 'followup', 'recap']) {
    await llm.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], mode, onToken: () => {} });
    assert.equal(capturedGeminiRequest.model, 'gemini-3.8-flash');
  }
});

test('Quick model is ignored when Quick is off, blank, or a retired id', async () => {
  const off = createLLM(geminiSettings({ quick: false, models: QUICK_SPLIT }));
  await off.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, 'gemini-3.8-flash');

  const blank = createLLM(geminiSettings({ quick: true, models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash', quick: '  ' } } }));
  assert.equal(blank.modelFor('ask'), 'gemini-3.8-flash');

  const retired = createLLM(geminiSettings({ quick: true, models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash', quick: 'gemini-2.0-flash' } } }));
  assert.equal(retired.modelFor('ask'), 'gemini-3.8-flash');
});

test('Quick model applies to OpenAI-compatible providers too', async () => {
  const llm = createLLM({
    provider: 'openai',
    quick: true,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4', smart: 'gpt-5.4', quick: 'gpt-5.4-mini' } }
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedCompletionRequest.model, 'gpt-5.4-mini');
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedCompletionRequest.model, 'gpt-5.4');
});

// gemini-2.5-flash-lite is the one 2.5 Flash model Google still serves without
// a shutdown date, so it stands in for the 2.5-era thinkingBudget code path.
const LEGACY_FLASH = { gemini: { fast: 'gemini-2.5-flash-lite', smart: 'gemini-2.5-flash-lite' } };

test('Gemini fast tier disables thinking for conversational modes', async () => {
  const llm = createLLM(geminiSettings({ smart: false, models: LEGACY_FLASH }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: () => {} });
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingBudget: 0 });
});

test('the default Gemini fast model stays at its own minimal thinking level', async () => {
  const llm = createLLM(geminiSettings({ smart: false }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, CURRENT_GEMINI_DEFAULT);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'MINIMAL', includeThoughts: true });
  // Never the 2.5-era numeric budget, and never a sampling parameter: Gemini 3.5+
  // deprecates temperature/top_p/top_k and later generations reject them.
  assert.equal(capturedGeminiRequest.config.thinkingConfig.thinkingBudget, undefined);
  assert.equal(capturedGeminiRequest.config.temperature, undefined);
});

test('3.5 Flash-Lite on the smart tier raises thinking so Smart is not a no-op', () => {
  assert.deepEqual(geminiThinkingConfig('gemini-3.5-flash-lite', 'ask', true), { thinkingLevel: 'HIGH', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-3.5-flash-lite', 'leetcode', false), { thinkingLevel: 'LOW', includeThoughts: true });
});

test('tokenBudget keeps conversational caps and enlarges LeetCode for commented walkthroughs', () => {
  assert.equal(tokenBudget('ask', false), 1400);
  assert.equal(tokenBudget('assist', true), 2800);
  assert.equal(tokenBudget('leetcode', false), 4096);
  assert.equal(tokenBudget('leetcode', true), 8192);
});

test('LeetCode Fast requests send the enlarged completion cap', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: false,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4-mini', smart: 'gpt-5.4' } }
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedCompletionRequest.max_completion_tokens, 4096);
});

test('LeetCode Smart requests send the enlarged completion cap', async () => {
  const llm = createLLM({
    provider: 'openai',
    smart: true,
    apiKeys: { openai: 'k' },
    models: { openai: { fast: 'gpt-5.4-mini', smart: 'gpt-5.4' } }
  });
  await llm.stream({ system: '', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedCompletionRequest.max_completion_tokens, 8192);
});

test('Gemini LeetCode uses a bounded thinking budget and the enlarged output cap', async () => {
  const fast = createLLM(geminiSettings({ smart: false, models: LEGACY_FLASH }));
  await fast.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 4096);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingBudget: 1024, includeThoughts: true });

  const smart = createLLM(geminiSettings({ smart: true, models: LEGACY_FLASH }));
  await smart.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 8192);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingBudget: 2048, includeThoughts: true });
});

test('LeetCode on the default Gemini models uses bounded thinking levels', async () => {
  const fast = createLLM(geminiSettings({ smart: false }));
  await fast.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });

  const smart = createLLM(geminiSettings({ smart: true }));
  await smart.stream({ system: 's', turns: [{ role: 'user', text: 'solve' }], mode: 'leetcode', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, CURRENT_GEMINI_SMART_DEFAULT);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });
});

test('Gemini 3.8 Flash keeps full thinking depth on the smart tier', async () => {
  // 3.8 Flash Smart intentionally leaves the level to the provider. This is
  // NOT the default Smart model any more (that is Hydrogen, below); pin the
  // model explicitly so a default change cannot silently revive this case.
  const llm = createLLM(geminiSettings({ smart: true, models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash' } } }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, 'gemini-3.8-flash');
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { includeThoughts: true });
});

// ---- Gemini 4 Hydrogen -----------------------------------------------------
// Released 2026-11-12 as Google's successor to 3.8 Flash. Its provider
// default is HIGH, and MINIMAL is rejected, so cue must set the level
// explicitly: LOW on the fast tier, MEDIUM on Smart. Before this fix
// geminiThinkingConfig only matched model ids containing "flash" and returned
// undefined for Hydrogen, leaving every QnA ask on the slow HIGH default.

test('Gemini 4 Hydrogen sets LOW fast / MEDIUM smart for QnA modes, never MINIMAL or the provider default', () => {
  for (const mode of ['ask', 'say', 'assist', 'answerThis', 'transcribe']) {
    assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', mode, false), { thinkingLevel: 'LOW', includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', mode, true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  }
  // LeetCode keeps the same bounded pair, so hidden thinking cannot eat the
  // enlarged output cap the way a HIGH default would.
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'leetcode', false), { thinkingLevel: 'LOW', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'leetcode', true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  // No code path in cue sends XHIGH or MINIMAL for Hydrogen.
  for (const mode of ['ask', 'leetcode']) {
    for (const smart of [false, true]) {
      const level = geminiThinkingConfig('gemini-4-hydrogen', mode, smart).thinkingLevel;
      assert.ok(['LOW', 'MEDIUM'].includes(level), `unexpected Hydrogen level ${level}`);
    }
  }
});

test('Gemini 4 adaptive level may lower Smart to LOW, never to MINIMAL or XHIGH, and never for LeetCode', () => {
  // A confidently simple Smart ask gets the adaptive LOW; anything else
  // keeps MEDIUM. The pick itself lives in src/adaptive-thinking.js and is
  // unit-tested there — here we only pin the plumbing.
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', true, 'LOW'), { thinkingLevel: 'LOW', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', true, 'MEDIUM'), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  // LeetCode ignores the adaptive level: a wrong-but-fast solution is worse
  // than a slow correct one.
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'leetcode', true, 'LOW'), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  // Fast ignores it too, and junk values are ignored everywhere.
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', false, 'LOW'), { thinkingLevel: 'LOW', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', true, 'MINIMAL'), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig('gemini-4-hydrogen', 'ask', true, 'XHIGH'), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  // 3.x Flash keeps its existing behaviour regardless of the adaptive pick.
  assert.deepEqual(geminiThinkingConfig('gemini-3.8-flash', 'ask', true, 'LOW'), { includeThoughts: true });
});

test('Gemini 4 adaptive LOW reaches the SDK through stream params', async () => {
  const llm = createLLM(geminiSettings({ smart: true }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'What is a mutex?' }], mode: 'ask', adaptiveThinkingLevel: 'LOW', onToken: () => {} });
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 2800);
});

test('Gemini 4 Carbon and Argon use the same explicit levels as Hydrogen', () => {
  for (const model of ['gemini-4-carbon', 'gemini-4-argon']) {
    assert.deepEqual(geminiThinkingConfig(model, 'ask', false), { thinkingLevel: 'LOW', includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig(model, 'ask', true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig(model, 'leetcode', true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  }
  // A Gemini 4 Pro model still keeps provider defaults.
  assert.equal(geminiThinkingConfig('gemini-4-pro', 'ask', false), undefined);
});

test('Gemini 4 Hydrogen Smart QnA sends MEDIUM through the SDK with the Smart token cap', async () => {
  const llm = createLLM(geminiSettings({ smart: true }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, CURRENT_GEMINI_SMART_DEFAULT);
  assert.equal(capturedGeminiRequest.model, 'gemini-4-hydrogen');
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 2800);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'MEDIUM', includeThoughts: true });
  assert.equal(capturedGeminiRequest.config.thinkingConfig.thinkingBudget, undefined);
});

test('Gemini 4 Hydrogen Fast QnA sends LOW through the SDK with the Fast token cap', async () => {
  const llm = createLLM(geminiSettings({ smart: false, models: { gemini: { fast: 'gemini-4-hydrogen', smart: 'gemini-4-hydrogen' } } }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, 'gemini-4-hydrogen');
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 1400);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
});

test('Gemini 3+ Flash uses thinkingLevel and never the legacy thinkingBudget', () => {
  for (const model of ['gemini-3.5-flash', 'gemini-3.8-flash', 'gemini-3.1-flash-lite']) {
    assert.deepEqual(geminiThinkingConfig(model, 'assist', false), { thinkingLevel: 'LOW', includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig(model, 'assist', true), { includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig(model, 'leetcode', false), { thinkingLevel: 'LOW', includeThoughts: true });
    assert.deepEqual(geminiThinkingConfig(model, 'leetcode', true), { thinkingLevel: 'MEDIUM', includeThoughts: true });
  }
});

test('Gemini 3 Flash Fast requests send thinkingLevel LOW through the SDK', async () => {
  const llm = createLLM(geminiSettings({ models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } } }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'say', onToken: () => {} });
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
});

test('Gemini Pro models keep provider-default thinking on every generation', () => {
  assert.equal(geminiThinkingConfig('gemini-2.5-pro', 'assist', false), undefined);
  assert.equal(geminiThinkingConfig('gemini-3.1-pro-preview', 'leetcode', true), undefined);
});

test('Gemini thought-only chunks report activity without emitting text', async () => {
  geminiScript.push(async () => (async function* () {
    yield { text: undefined };
    yield { text: undefined };
    yield { text: 'answer' };
  })());
  const llm = createLLM(geminiSettings());
  const tokens = [];
  let activity = 0;
  const full = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: (t) => tokens.push(t), onActivity: () => { activity++; } });
  assert.equal(full, 'answer');
  assert.deepEqual(tokens, ['answer']);
  assert.equal(activity, 2);
});

function overloadError() {
  const e = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}');
  e.status = 503;
  return e;
}

test('isOverloadedError recognizes 503/529 overloads but not quota or 404', () => {
  assert.equal(isOverloadedError(overloadError()), true);
  assert.equal(isOverloadedError(Object.assign(new Error('Overloaded'), { status: 529 })), true);
  assert.equal(isOverloadedError(Object.assign(new Error('Quota exceeded'), { status: 429 })), false);
  assert.equal(isOverloadedError(Object.assign(new Error('model is unavailable'), { status: 404 })), false);
});

test('a 503 before any text is retried and the answer still arrives', async () => {
  geminiScript.push(async () => { throw overloadError(); });
  const llm = createLLM(geminiSettings());
  const tokens = [];
  let activity = 0;
  const full = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: (t) => tokens.push(t), onActivity: () => { activity++; }, retryDelaysMs: [0, 0] });
  assert.equal(full, 'ok');
  assert.deepEqual(tokens, ['ok']);
  assert.equal(geminiCalls, 2);
  assert.equal(activity, 1);
});

test('persistent 503s give up after the retries with a friendly message', async () => {
  geminiScript.push(async () => { throw overloadError(); }, async () => { throw overloadError(); }, async () => { throw overloadError(); });
  const llm = createLLM(geminiSettings({ models: { gemini: { fast: 'gemini-3.5-flash', smart: 'gemini-3.5-flash' } } }));
  await assert.rejects(
    llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: () => {}, retryDelaysMs: [0, 0] }),
    /Gemini model "gemini-3\.5-flash" is overloaded right now/
  );
  assert.equal(geminiCalls, 3);
});

test('a 503 after text has streamed is not retried (no duplicated answer)', async () => {
  geminiScript.push(async () => (async function* () {
    yield { text: 'partial' };
    throw overloadError();
  })());
  const llm = createLLM(geminiSettings());
  const tokens = [];
  await assert.rejects(llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: (t) => tokens.push(t), retryDelaysMs: [0, 0] }));
  assert.deepEqual(tokens, ['partial']);
  assert.equal(geminiCalls, 1);
});

test('Gemini never sends a zero thinking budget to non-flash models', async () => {
  const llm = createLLM(geminiSettings({
    smart: false,
    models: { gemini: { fast: 'gemini-2.5-pro', smart: 'gemini-2.5-pro' } }
  }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'assist', onToken: () => {} });
  assert.equal(capturedGeminiRequest.config.thinkingConfig, undefined);
});

test('Anthropic marks the reusable system prompt as cacheable', async () => {
  const llm = createLLM({
    provider: 'anthropic',
    smart: false,
    apiKeys: { anthropic: 'k' },
    models: {}
  });
  await llm.stream({ system: 'You are cue.', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
  assert.deepEqual(capturedAnthropicRequest.system, [
    { type: 'text', text: 'You are cue.', cache_control: { type: 'ephemeral' } }
  ]);
  assert.equal(capturedAnthropicRequest.max_tokens, tokenBudget(undefined, false));
});

test('Anthropic gets a cache breakpoint after the part of the prompt that never changes', async () => {
  const llm = createLLM({ provider: 'anthropic', smart: false, apiKeys: { anthropic: 'k' }, models: {} });
  const fixed = '=== Meeting Document ===\nlong reference text';
  const system = fixed + '\n\nYou are cue. Answer the behavioral question.';
  await llm.stream({ system, cachePrefixChars: fixed.length, turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });

  const blocks = capturedAnthropicRequest.system;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, fixed);
  assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(blocks[1].cache_control, { type: 'ephemeral' });
  assert.equal(blocks[0].text + blocks[1].text, system, 'the model must receive exactly the original prompt');
});

test('a cache prefix that covers the whole prompt (or none of it) falls back to one block', async () => {
  const llm = createLLM({ provider: 'anthropic', smart: false, apiKeys: { anthropic: 'k' }, models: {} });
  for (const cachePrefixChars of [0, 12, 999]) {
    await llm.stream({ system: 'You are cue.', cachePrefixChars, turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
    assert.equal(capturedAnthropicRequest.system.length, 1);
    assert.equal(capturedAnthropicRequest.system[0].text, 'You are cue.');
  }
});

// ---- token usage reporting (feeds the CUE_PERF timing lines) -----------------

test('Gemini reports prompt, cached and output token counts', async () => {
  geminiScript.push(async () => (async function* () {
    yield { text: 'par', usageMetadata: { promptTokenCount: 3310, candidatesTokenCount: 4 } };
    yield { text: 'tial', usageMetadata: { promptTokenCount: 3310, cachedContentTokenCount: 2816, candidatesTokenCount: 212, thoughtsTokenCount: 9 } };
  })());
  const llm = createLLM(geminiSettings());
  let usage = null;
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], mode: 'ask', onToken: () => {}, onUsage: (u) => { usage = u; } });
  assert.deepEqual(usage, { promptTokens: 3310, cachedTokens: 2816, outputTokens: 212, thoughtTokens: 9 });
});

test('Anthropic reports cache reads as part of the prompt size', async () => {
  anthropicEvents = [
    { type: 'message_start', message: { usage: { input_tokens: 120, cache_read_input_tokens: 2400, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
    { type: 'message_delta', usage: { output_tokens: 57 } }
  ];
  const llm = createLLM({ provider: 'anthropic', smart: false, apiKeys: { anthropic: 'k' }, models: {} });
  let usage = null;
  const text = await llm.stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {}, onUsage: (u) => { usage = u; } });
  assert.equal(text, 'ok');
  assert.deepEqual(usage, { cachedTokens: 2400, promptTokens: 2520, outputTokens: 57 });
});

function fakeOllamaResponse(lines) {
  return { ok: true, status: 200, body: (async function* () { for (const line of lines) yield Buffer.from(line); })() };
}

async function withFakeFetch(fakeFetch, run) {
  const originalFetch = global.fetch;
  global.fetch = fakeFetch;
  try { return await run(); } finally { global.fetch = originalFetch; }
}

test('Ollama requests use the configured context size and report Ollama\'s own counters', async () => {
  const bodies = [];
  const fakeFetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return fakeOllamaResponse([
      JSON.stringify({ message: { content: 'hel' } }) + '\n',
      JSON.stringify({ message: { content: 'lo' } }) + '\n' +
        // Final line arrives without a trailing newline.
        JSON.stringify({ done: true, prompt_eval_count: 812, prompt_eval_duration: 1500000000, eval_count: 40, eval_duration: 2000000000, load_duration: 5000000 })
    ]);
  };
  const settings = (notesContextTokens) => ({
    provider: 'ollama', apiKeys: { ollama: 'http://127.0.0.1:59000' }, models: { ollama: { fast: 'qwen', smart: 'qwen' } }, notesContextTokens
  });

  await withFakeFetch(fakeFetch, async () => {
    let usage = null;
    const tokens = [];
    const text = await createLLM(settings(8192)).stream({
      system: 's', turns: [{ role: 'user', text: 'hi' }], maxTokens: 250, onToken: (t) => tokens.push(t), onUsage: (u) => { usage = u; }
    });
    assert.equal(text, 'hello');
    assert.deepEqual(tokens, ['hel', 'lo']);
    assert.equal(bodies[0].options.num_ctx, 8192);
    assert.equal(bodies[0].options.num_predict, 250);
    assert.deepEqual(usage, { promptTokens: 812, outputTokens: 40, promptEvalMs: 1500, evalMs: 2000, loadMs: 5 });

    // Unset or too-small values fall back to the default rather than a window
    // that silently truncates the notes.
    await createLLM(settings(undefined)).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
    await createLLM(settings(1024)).stream({ system: 's', turns: [{ role: 'user', text: 'hi' }], onToken: () => {} });
    assert.equal(bodies[1].options.num_ctx, 4096);
    assert.equal(bodies[2].options.num_ctx, 4096);
  });
});

test('fetch-transport warmups repeat once the idle-socket window has passed', async (t) => {
  let warmups = 0;
  const methods = [];
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });
  const fakeFetch = async (_url, init) => {
    warmups += 1;
    methods.push((init && init.method) || 'GET');
    return { arrayBuffer: async () => new ArrayBuffer(0) };
  };
  await withFakeFetch(fakeFetch, async () => {
    const llm = createLLM({ provider: 'ollama', apiKeys: { ollama: 'http://127.0.0.1:59001' }, models: { ollama: { fast: 'm', smart: 'm' } } });
    assert.equal(llm.warmAgeMs(), null);
    llm.warmup();
    llm.warmup();
    assert.equal(warmups, 1, 'a second warmup inside the window is skipped');
    assert.equal(llm.warmAgeMs(), 0);

    t.mock.timers.tick(FETCH_WARMUP_TTL_MS + 1);
    llm.warmup();
    assert.equal(warmups, 2, 'the socket has gone idle, so it is opened again');
    // Node's fetch closes idle sockets after about 4 seconds.
    assert.ok(FETCH_WARMUP_TTL_MS < 4000);
    // Never HEAD: Node's fetch closes the connection after a HEAD response,
    // which would leave nothing warm for the real request.
    assert.deepEqual(methods, ['GET', 'GET']);
  });
});

test('warmup exists and is a safe no-op when configuration is incomplete', () => {
  const notReady = createLLM(createCustomSettings({ baseUrl: '' }));
  assert.equal(notReady.ready, false);
  assert.equal(typeof notReady.warmup, 'function');
  assert.doesNotThrow(() => notReady.warmup());
});

test('Quick mode keeps the user-configured Gemini 3.8 Flash model with LOW thinking and a tight token cap', async () => {
  const llm = createLLM(geminiSettings({
    quick: true,
    smart: true,
    models: { gemini: { fast: 'gemini-3.8-flash', smart: 'gemini-3.8-flash' } }
  }));
  await llm.stream({ system: 's', turns: [{ role: 'user', text: 'worm vs virus' }], mode: 'ask', onToken: () => {} });
  assert.equal(capturedGeminiRequest.model, 'gemini-3.8-flash');
  assert.equal(capturedGeminiRequest.config.maxOutputTokens, 1400);
  assert.deepEqual(capturedGeminiRequest.config.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
});
