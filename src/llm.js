// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, mode, onToken }) -> Promise<fullText>

const http = require('http');
const https = require('https');
const AgentKeepAlive = require('agentkeepalive');
const { createCompatibleClientOptions } = require('./openai-compatible');

// ---- shared keep-alive agents -----------------------------------------------
// The OpenAI/Anthropic SDKs default to an internal agent whose free sockets die
// after 4s of idle — so every sporadic ask pays a fresh TCP+TLS handshake
// (~100–400ms before the first byte). Owning the agent lets us (a) keep sockets
// warm for a realistic between-asks window and (b) pre-open a connection with
// warmup() below through the exact same pool the real request will use.
const KEEP_ALIVE_OPTS = { keepAlive: true, timeout: 5 * 60 * 1000, freeSocketTimeout: 30000 };
const sharedHttpsAgent = new AgentKeepAlive.HttpsAgent(KEEP_ALIVE_OPTS);
const sharedHttpAgent = new AgentKeepAlive(KEEP_ALIVE_OPTS);

function agentFor(url) {
  return /^http:/i.test(String(url || '')) ? sharedHttpAgent : sharedHttpsAgent;
}

// ---- connection warmup -------------------------------------------------------
// Fire-and-forget HEAD to the provider's origin so TCP+TLS finish while cue is
// still capturing the screenshot / while the user is still typing. Errors are
// swallowed: a failed warmup never affects the real request, which opens its
// own socket if the pool is empty. Deduped per origin so rapid asks don't spam.
const WARMUP_TTL_MS = 20000;
const lastWarmupAt = new Map();

function warmOrigin(url, useNodeAgent) {
  let origin;
  try { origin = new URL(url).origin; } catch { return; }
  const now = Date.now();
  if (now - (lastWarmupAt.get(origin) || 0) < WARMUP_TTL_MS) return;
  lastWarmupAt.set(origin, now);
  try {
    if (useNodeAgent) {
      // Same agent the SDK clients use, so the socket lands in their free pool.
      const lib = origin.startsWith('http:') ? http : https;
      const req = lib.request(origin + '/', { method: 'HEAD', agent: agentFor(origin), timeout: 4000 }, (res) => res.resume());
      req.on('timeout', () => req.destroy());
      req.on('error', () => {});
      req.end();
    } else {
      // Gemini/Ollama go through global fetch (undici), which pools per origin.
      fetch(origin + '/', { method: 'HEAD', signal: AbortSignal.timeout(4000) })
        .then((res) => { if (res && res.body && typeof res.body.cancel === 'function') res.body.cancel().catch(() => {}); })
        .catch(() => {});
    }
  } catch { /* warmup must never break anything */ }
}

const CUSTOM_PROVIDER = 'custom';
// gemini-2.0-flash was Google's default here until it was deprecated (Feb 2026)
// and fully retired (Mar 3 2026) — every request against it now 404s with a
// generic "exception parsing response" body. gemini-2.5-flash is the model
// Google's own SDK examples standardize on and is documented as free-tier
// available, so it is the single default used everywhere in this file.
const CURRENT_GEMINI_DEFAULT = 'gemini-2.5-flash';
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-haiku-latest',
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  azure: 'gpt-4o-mini'
};

// Gemini model ids that Google has since deprecated/retired. A settings file
// saved before this fix can still have one of these persisted on disk, so
// createLLM migrates them at read time rather than only fixing the default —
// otherwise an existing user would keep re-hitting the same 404 forever.
const DEAD_GEMINI_MODEL_RE = /^gemini-(1\.0|1\.5|2\.0)(?:-|$)/i;

const PROVIDER_LABELS = { azure: 'Azure AI Foundry', openai: 'OpenAI', minimax: 'MiniMax' };

function normalizeProviderName(provider) {
  if (!provider) return 'provider';
  if (PROVIDER_LABELS[provider]) return PROVIDER_LABELS[provider];
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

// Pulled out so both the LLM and STT error paths (llm.js and stt.js) agree on
// what counts as a rate-limit/quota failure instead of drifting independently.
function isQuotaError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 429 || code === 429 || code === 'insufficient_quota' || code === 'rate_limit_exceeded' ||
    code === 'RESOURCE_EXHAUSTED' || /quota|billing|rate limit|exceeded your current quota|resource_exhausted|too many requests/i.test(text);
}

// 503 = provider out of capacity (Gemini "high demand", OpenAI overload);
// 529 = Anthropic "overloaded". Both are transient and safe to retry as long
// as no text has streamed yet.
function isOverloadedError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  if (isQuotaError(error) || isNotFoundError(error)) return false;
  return status === 503 || status === 529 || code === 503 || code === 529 ||
    code === 'UNAVAILABLE' || /\b(503|529)\b|overloaded|high demand/i.test(rawMessage) ||
    /\bUNAVAILABLE\b/.test(rawMessage);
}

function isNotFoundError(error) {
  const status = error && (error.status || error.statusCode || error.response?.status);
  const code = error && (error.code || error.error?.code);
  const rawMessage = (error && (error.message || String(error))) || '';
  const text = `${rawMessage} ${status || ''} ${code || ''}`.toLowerCase();
  return status === 404 || code === 404 || /\b404\b|is not found for api version|model not found/i.test(text);
}

// Gemini 429 bodies often carry a google.rpc.RetryInfo detail like
// {"retryDelay":"38s"} inside the JSON error text. Not every quota error has
// one (OpenAI/Anthropic don't), so this is best-effort and returns null when
// absent instead of guessing a wait time.
function extractRetryDelaySeconds(rawMessage) {
  const match = /retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)\s*s/i.exec(String(rawMessage || ''));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

function formatRetryWait(seconds) {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

function formatProviderErrorMessage(error, provider, model) {
  const label = normalizeProviderName(provider);
  const rawMessage = (error && (error.message || String(error))) || '';

  if (isQuotaError(error)) {
    const retrySeconds = extractRetryDelaySeconds(rawMessage);
    const waitHint = retrySeconds ? ` Wait about ${formatRetryWait(retrySeconds)}` : ' Wait a moment';
    return `${label} free-tier quota exhausted (429 Too Many Requests).${waitHint} and try again, or add billing to your ${label} account. You can also switch providers or models in Settings.`;
  }

  if (isNotFoundError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is unavailable (404) — it may have been renamed, retired by the provider, or misspelled. Open Settings and pick a current model for ${label} (or clear the field to use cue's default), then try again.`;
  }

  if (isOverloadedError(error)) {
    const modelHint = model ? ` "${model}"` : '';
    return `${label} model${modelHint} is overloaded right now (high demand). This is usually temporary — try again in a minute, or pick a less busy model in Settings.`;
  }

  return rawMessage || 'Unknown LLM error.';
}

function sanitizeTurns(turns) {
  const valid = new Set(['user', 'assistant']);
  return (turns || []).filter(t => valid.has(t.role)).map(t => ({ role: t.role, text: String(t.text || '') }));
}

// MiniMax is OpenAI-compatible and exposes two regional gateways. MiniMax-M3
// accepts image input, so it reuses the OpenAI screenshot path via baseURL.
const MINIMAX_BASE_URLS = {
  global_en: 'https://api.minimax.io/v1',
  cn_zh: 'https://api.minimaxi.com/v1'
};

function stripDataUrl(dataUrl) {
  const m = /^data:(.+?);base64,(.*)$/s.exec(dataUrl || '');
  return m ? { mime: m[1], b64: m[2] } : null;
}

// o-series and GPT-5.x run a hidden reasoning pass before the first visible
// token. gpt-4o-mini and friends reject this param, so it is only set when the
// model id is clearly a reasoning model.
function isReasoningChatModel(model) {
  const id = String(model || '').trim().toLowerCase();
  return /^(o[1-9]|gpt-5)/.test(id) || id.includes('gpt-5');
}

// Conversational modes stay glance-and-go. LeetCode now emits a line-commented
// walkthrough + complexity + alternatives, and reasoning models (GPT-5, Gemini
// Flash thinking) spend this SAME budget on hidden tokens first — 700/1400
// truncates the visible answer mid-code.
function tokenBudget(mode, smart) {
  if (mode === 'leetcode') return smart ? 8192 : 4096;
  return smart ? 2800 : 1400;
}

function geminiMajorVersion(model) {
  const m = /gemini-(\d+)/i.exec(String(model || ''));
  return m ? Number(m[1]) : 0;
}

// Gemini 2.5 Flash takes a numeric thinkingBudget (0 = off). Gemini 3+ replaced
// it with thinkingLevel; sending both is a 400, and 3.7/3.8 Flash reject the
// MINIMAL level, so LOW is the fastest level every 3.x Flash accepts.
// includeThoughts streams thought summaries while the model reasons — the SDK's
// chunk.text excludes them, but they tell the caller the stream is alive.
// Pro models keep provider defaults (they reject a zero budget).
function geminiThinkingConfig(model, mode, smart) {
  if (!/flash/i.test(model) || /pro/i.test(model)) return undefined;
  const leetcode = mode === 'leetcode';
  if (geminiMajorVersion(model) >= 3) {
    if (leetcode) return { thinkingLevel: smart ? 'MEDIUM' : 'LOW', includeThoughts: true };
    if (!smart) return { thinkingLevel: 'LOW', includeThoughts: true };
    return { includeThoughts: true };
  }
  if (leetcode) return { thinkingBudget: smart ? 2048 : 1024, includeThoughts: true };
  if (!smart) return { thinkingBudget: 0 };
  return { includeThoughts: true };
}

const OVERLOAD_RETRY_DELAYS_MS = [1200, 3000];

async function streamOpenAI({ apiKey, baseURL, model, system, turns, imageDataUrl, maxTokens, onToken, useMaxCompletionTokens, reasoningEffort }) {
  const OpenAI = require('openai');
  const httpAgent = agentFor(baseURL || 'https://api.openai.com');
  const client = new OpenAI(baseURL ? { apiKey, baseURL, httpAgent } : { apiKey, httpAgent });
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({
        role: 'user', content: [
          { type: 'text', text: t.text },
          { type: 'image_url', image_url: { url: imageDataUrl } }
        ]
      });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  // api.openai.com accepts max_completion_tokens on every current chat model and
  // REQUIRES it on reasoning models (o-series and newer), where the legacy
  // max_tokens param errors. Third-party OpenAI-compatible endpoints (custom
  // gateways, MiniMax, Groq, Ollama-compat) are not guaranteed to know the new
  // param, so they keep max_tokens.
  const tokenParam = useMaxCompletionTokens ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const reasoningParam = reasoningEffort ? { reasoning_effort: reasoningEffort } : {};
  const stream = await client.chat.completions.create({ model, messages, stream: true, ...tokenParam, ...reasoningParam });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

// Azure AI Foundry Models API (cognitiveservices.azure.com hosts) lives under
// {endpoint}/openai/v1 and authenticates with the `api-key` header.
function normalizeAzureBaseURL(raw) {
  let u = String(raw || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/i, '');
  if (!u) return '';
  if (/cognitiveservices\.azure\.com/i.test(u) && !/\/openai\/v1$/i.test(u)) {
    u += '/openai/v1';
  }
  return u;
}

async function streamAzure({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, endpoint, reasoningEffort }) {
  const url = normalizeAzureBaseURL(endpoint);
  if (!url) throw new Error('Missing Azure endpoint. Add your Azure AI Foundry or Azure OpenAI endpoint in Settings.');
  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      messages.push({ role: 'user', content: [
        { type: 'text', text: t.text },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ] });
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });
  const OpenAI = require('openai');
  let client;
  if (/openai\.azure\.com/i.test(url)) {
    client = new OpenAI.AzureOpenAI({ endpoint: url.replace(/\/openai$/i, ''), apiKey, apiVersion: '2024-10-21', httpAgent: agentFor(url) });
  } else {
    // Foundry / OpenAI-compatible base: force the `api-key` header and drop the
    // Authorization header the SDK adds by default (those hosts don't take a Bearer key).
    const azureFetch = async (input, init) => {
      const headers = new Headers(init && init.headers);
      headers.set('api-key', apiKey);
      headers.delete('authorization');
      return fetch(input, { ...init, headers });
    };
    client = new OpenAI({ baseURL: url, apiKey, fetch: azureFetch });
  }
  const reasoningParam = reasoningEffort ? { reasoning_effort: reasoningEffort } : {};
  const stream = await client.chat.completions.create({ model, messages, stream: true, max_completion_tokens: maxTokens, ...reasoningParam });
  let full = '';
  for await (const part of stream) {
    const d = part.choices && part.choices[0] && part.choices[0].delta && part.choices[0].delta.content;
    if (d) { full += d; onToken(d); }
  }
  return full;
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken }) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey, httpAgent: sharedHttpsAgent });
  const messages = turns.map((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      const content = [];
      if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.b64 } });
      content.push({ type: 'text', text: t.text });
      return { role: 'user', content };
    }
    return { role: t.role, content: t.text };
  });
  // The system prompt (mode instructions + résumé/context block) is identical
  // across consecutive asks, so mark it cacheable: repeat requests within the
  // 5-minute cache window skip re-processing that prefix — faster first token
  // and ~90% cheaper on those tokens. Below Anthropic's minimum cacheable size
  // the flag is simply ignored, so this is never a downside for short prompts.
  const systemParam = system
    ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
    : undefined;
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system: systemParam, messages, stream: true });
  let full = '';
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
  }
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, thinkingConfig }) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const contents = turns.map((t, i) => {
    const last = i === turns.length - 1;
    const parts = [{ text: t.text }];
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.b64 } });
    }
    return { role: t.role === 'assistant' ? 'model' : 'user', parts };
  });
  const config = { systemInstruction: system, maxOutputTokens: maxTokens };
  if (thinkingConfig) config.thinkingConfig = thinkingConfig;
  const stream = await ai.models.generateContentStream({ model, contents, config });
  let full = '';
  for await (const chunk of stream) {
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
    else if (onActivity) onActivity();
  }
  return full;
}

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, signal }) {
  const baseUrl = apiKey || 'http://localhost:11434';
  const url = `${baseUrl.replace(/\/$/, '')}/api/chat`;

  const messages = [{ role: 'system', content: system }];
  turns.forEach((t, i) => {
    const last = i === turns.length - 1;
    if (last && imageDataUrl && t.role === 'user') {
      const img = stripDataUrl(imageDataUrl);
      if (img) {
        messages.push({ role: 'user', content: t.text, images: [img.b64] });
      } else {
        messages.push({ role: 'user', content: t.text });
      }
    } else {
      messages.push({ role: t.role, content: t.text });
    }
  });

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        keep_alive: '30m',
        options: {
          num_ctx: 2048,
          num_predict: maxTokens || 800,
          temperature: 0.2
        }
      })
    });
  } catch (err) {
    throw new Error(`Ollama fetch failed: ${err.message}. Is Ollama running at ${baseUrl}?`);
  }

  if (onActivity) onActivity();

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
  }

  const decoder = new TextDecoder();
  let full = '';
  let buffer = '';
  for await (const chunk of response.body) {
    if (onActivity) onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        if (data.message && data.message.content) {
          full += data.message.content;
          onToken(data.message.content);
        }
      } catch (e) {
        // ignore
      }
    }
  }
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer);
      if (data.message && data.message.content) {
        full += data.message.content;
        onToken(data.message.content);
      }
    } catch (e) { }
  }
  return full;
}

function createLLM(settings) {
  const provider = settings.provider;
  const keys = settings.apiKeys || {};
  let apiKey = keys[provider];
  let baseURL = '';
  let configurationError = '';
  const tier = settings.smart ? 'smart' : 'fast';
  const models = settings.models || {};
  let model = (models[provider] || {})[tier];
  if (provider === 'gemini' && DEAD_GEMINI_MODEL_RE.test(model || '')) {
    model = CURRENT_GEMINI_DEFAULT;
  }
  if (!model) model = DEFAULT_MODELS[provider] || '';
  const minimaxRegion = settings.minimaxRegion || 'global_en';
  const endpoint = settings.azureEndpoint || '';

  if (provider === CUSTOM_PROVIDER) {
    try {
      const clientOptions = createCompatibleClientOptions(apiKey, settings.baseUrl);
      apiKey = clientOptions.apiKey;
      baseURL = clientOptions.baseURL;
    } catch (error) {
      configurationError = error.message;
    }
    if (!model && !configurationError) {
      configurationError = 'Set a Fast or Smart model for the Custom provider.';
    }
  } else if (provider !== 'ollama' && !apiKey) {
    // Ollama is a local server: the field holds a URL, and no key is required.
    configurationError = `Add your ${provider} API key in Settings.`;
  }

  // Azure needs a second credential: the resource endpoint.
  if (!configurationError && provider === 'azure' && !endpoint) {
    configurationError = 'Add your Azure AI Foundry endpoint in Settings.';
  }

  const ready = !configurationError && !!model;

  // Where a pre-opened connection should point, and whether it must go through
  // the shared node agent (SDK transport) or global fetch (undici transport).
  function warmupTarget() {
    if (provider === 'openai') return { url: baseURL || 'https://api.openai.com', nodeAgent: true };
    if (provider === CUSTOM_PROVIDER) return baseURL ? { url: baseURL, nodeAgent: true } : null;
    if (provider === 'groq') return { url: 'https://api.groq.com', nodeAgent: true };
    if (provider === 'minimax') return { url: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en, nodeAgent: true };
    if (provider === 'anthropic') return { url: 'https://api.anthropic.com', nodeAgent: true };
    if (provider === 'gemini') return { url: 'https://generativelanguage.googleapis.com', nodeAgent: false };
    if (provider === 'ollama') return { url: apiKey || 'http://localhost:11434', nodeAgent: false };
    if (provider === 'azure') {
      const url = normalizeAzureBaseURL(endpoint);
      // The openai.azure.com path uses the SDK transport; Foundry hosts go
      // through a custom fetch wrapper (global fetch), mirroring streamAzure.
      return url ? { url, nodeAgent: /openai\.azure\.com/i.test(url) } : null;
    }
    return null;
  }

  return {
    provider, model, apiKey, baseURL,
    ready,
    configurationError,
    // Pre-open the TCP+TLS connection to the provider while the screenshot is
    // being captured (or while the user is still typing). Fire-and-forget.
    warmup() {
      if (!ready) return;
      const target = warmupTarget();
      if (target && target.url) warmOrigin(target.url, target.nodeAgent);
    },
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const isQuick = !!settings.quick && params.mode !== 'leetcode';
      const effectiveSmart = isQuick ? false : !!settings.smart;
      const args = { apiKey, baseURL, endpoint, model, ...params, turns: sanitizeTurns(params.turns) };
      // Caller can pass maxTokens explicitly (tests); otherwise size the cap
      // to the mode. LeetCode needs a much larger budget than Assist.
      if (params.maxTokens == null) args.maxTokens = isQuick ? 1400 : tokenBudget(params.mode, effectiveSmart);
      // Fast tier + conversational mode: keep Gemini's hidden reasoning short.
      // LeetCode always keeps some thinking (answer depth), bounded so hidden
      // tokens cannot eat maxOutputTokens and cut the walkthrough off.
      args.thinkingConfig = provider === 'gemini'
        ? geminiThinkingConfig(model, params.mode, effectiveSmart)
        : undefined;
      // Fast-tier GPT-5 / o-series: skip the long hidden reasoning pass. Smart
      // and LeetCode keep the provider default so hard problems stay deep.
      args.reasoningEffort = (provider === 'openai' || provider === 'azure')
        && !effectiveSmart
        && params.mode !== 'leetcode'
        && isReasoningChatModel(model)
        ? 'low'
        : undefined;
      const dispatch = (a) => {
        if (provider === 'openai') return streamOpenAI({ ...a, useMaxCompletionTokens: true });
        if (provider === CUSTOM_PROVIDER) return streamOpenAI(a);
        if (provider === 'ollama') return streamOllama(a);
        if (provider === 'groq') return streamOpenAI({ ...a, baseURL: 'https://api.groq.com/openai/v1' });
        if (provider === 'minimax') return streamOpenAI({ ...a, baseURL: MINIMAX_BASE_URLS[minimaxRegion] || MINIMAX_BASE_URLS.global_en });
        if (provider === 'anthropic') return streamAnthropic(a);
        if (provider === 'gemini') return streamGemini(a);
        if (provider === 'azure') return streamAzure(a);
        throw new Error('unknown provider: ' + provider);
      };
      const retryDelays = params.retryDelaysMs || OVERLOAD_RETRY_DELAYS_MS;
      for (let attempt = 0; ; attempt++) {
        // Only retry before any text reached the user — a retry after that
        // would duplicate the start of the answer.
        let emitted = false;
        const onToken = (t) => { emitted = true; params.onToken(t); };
        try {
          return await dispatch({ ...args, onToken });
        } catch (error) {
          if (!emitted && attempt < retryDelays.length && isOverloadedError(error)) {
            if (params.onActivity) params.onActivity();
            await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
            continue;
          }
          throw new Error(formatProviderErrorMessage(error, provider, model));
        }
      }
    }
  };
}

module.exports = { createLLM, formatProviderErrorMessage, isQuotaError, isOverloadedError, agentFor, CURRENT_GEMINI_DEFAULT, isReasoningChatModel, tokenBudget, geminiThinkingConfig };
