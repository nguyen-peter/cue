// LLM factory — OpenAI, Anthropic, Gemini, and OpenAI-compatible APIs behind one streaming interface.
// stream({ system, turns:[{role,text}], imageDataUrl, maxTokens, mode, onToken }) -> Promise<fullText>

const http = require('http');
const https = require('https');
const AgentKeepAlive = require('agentkeepalive');
const { createCompatibleClientOptions } = require('./openai-compatible');
const { normalizeNotesContextTokens } = require('./notes');

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
//
// The dedupe window has to be shorter than the time an idle socket survives,
// or a "still warm" origin is really a closed connection. The SDK agent above
// keeps free sockets for 30s. Global fetch (Gemini, Ollama, Azure Foundry) is
// different: measured under Electron 33 / Node 20, an idle socket was reused
// after 3.5s and gone after 4.5s unless the server asks for longer.
const WARMUP_TTL_MS = 20000;
const FETCH_WARMUP_TTL_MS = 3000;
const lastWarmupAt = new Map();

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

// Milliseconds since this origin last had a warmup or a real request, or null.
function warmAgeMs(url) {
  const origin = originOf(url);
  const at = origin ? lastWarmupAt.get(origin) : 0;
  return at ? Date.now() - at : null;
}

// A finished request leaves its socket in the pool, which is as good as a warmup.
function noteOriginUse(url) {
  const origin = originOf(url);
  if (origin) lastWarmupAt.set(origin, Date.now());
}

function warmOrigin(url, useNodeAgent) {
  const origin = originOf(url);
  if (!origin) return;
  const now = Date.now();
  const ttl = useNodeAgent ? WARMUP_TTL_MS : FETCH_WARMUP_TTL_MS;
  if (now - (lastWarmupAt.get(origin) || 0) < ttl) return;
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
      // GET, not HEAD: undici closes the socket after every HEAD response
      // (measured: three HEADs open three connections, three GETs share one),
      // so a HEAD leaves nothing for the real request to reuse. The body is
      // read to the end because a socket only goes back to the pool once its
      // response is consumed; these origins answer "/" with a small page.
      fetch(origin + '/', { signal: AbortSignal.timeout(4000) })
        .then((res) => res.arrayBuffer())
        .catch(() => {});
    }
  } catch { /* warmup must never break anything */ }
}

const CUSTOM_PROVIDER = 'custom';
// Default models, checked against each provider's deprecation page on
// 2026-11-13. Update the date when re-checking.
//
// Gemini: gemini-2.0-flash is retired. gemini-2.5-flash, the default after it,
// is now deprecated too: Google limits it to accounts that already used it,
// and from 2026-12-01 routes its requests to gemini-3.5-flash-lite, which
// expects the Gemini 3 thinking parameters. 3.5 Flash-Lite is Google's named
// replacement for 2.5 Flash and the fastest 3.x model; 3.8 Flash is the current
// top Flash model. Both are free-tier available and accept audio input.
// Gemini 4 Hydrogen (gemini-4-hydrogen, released 2026-11-12) is Google's
// named successor to 3.8 Flash for everyday coding and agentic work, and is
// now the Smart default: it is faster than 3.8 Flash at the same thinking
// depth, but only when cue sets thinkingLevel explicitly (see
// geminiThinkingConfig below). Fast stays on 3.5 Flash-Lite, the fastest
// model for short QnA, and STT stays on it too (src/stt.js).
const CURRENT_GEMINI_DEFAULT = 'gemini-3.5-flash-lite';
const CURRENT_GEMINI_SMART_DEFAULT = 'gemini-4-hydrogen';
// Anthropic: every Claude 3.x model (including the 3.5 Haiku / 3.5 Sonnet
// "-latest" aliases cue used to default to) is retired and fails outright.
// OpenAI: gpt-4o-mini / gpt-4o still work but are scheduled for removal on
// 2027-01-14; left unchanged until a replacement has been tested with cue.
const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-5-5',
  gemini: CURRENT_GEMINI_DEFAULT,
  ollama: 'llama3.2',
  groq: 'llama-3.1-8b-instant',
  minimax: 'MiniMax-M2.7',
  azure: 'gpt-4o-mini'
};
// Smart-tier fallbacks, only where the smart default differs from the fast one.
const DEFAULT_SMART_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  gemini: CURRENT_GEMINI_SMART_DEFAULT
};

// Model ids a provider has retired (or, for 2.5 Flash, is about to reroute). A
// settings file saved earlier can still have one persisted on disk, so
// createLLM replaces them at read time rather than only fixing the default —
// otherwise an existing user would keep re-hitting the same error forever.
// gemini-2.5-flash-lite is NOT deprecated and is deliberately excluded.
const DEAD_GEMINI_MODEL_RE = /^gemini-(?:(?:1\.0|1\.5|2\.0)(?:-|$)|2\.5-flash(?!-lite)(?:-|$))/i;
const RETIRED_ANTHROPIC_MODEL_RE = /^claude-(?:instant|[123])(?:[.-]|$)/i;

// Modes that get the context-free Quick prompt when Quick is on. LeetCode is
// deliberately absent so hard problems always reach the main model.
const QUICK_MODES = new Set(['ask', 'say', 'assist', 'answerThis']);

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

// 3.5 Flash-Lite thinks at MINIMAL by default and is the one 3.x Flash model
// cue targets that documents that level; forcing LOW on it would make the fast
// tier slower than the model's own default.
function defaultsToMinimalThinking(model) {
  return /^gemini-3\.5-flash-lite/i.test(String(model || ''));
}

// Models cue is allowed to set a thinking level on. Flash models, plus the
// Gemini 4 family (Hydrogen / Carbon / Argon, matched by name, not by the
// "flash" label they no longer carry). Pro models keep provider defaults
// (they reject a zero budget).
function isGeminiThinkingModel(model) {
  const id = String(model || '');
  if (/pro/i.test(id)) return false;
  return /flash/i.test(id) || /^gemini-4-(hydrogen|carbon|argon)/i.test(id) || /^gemini-4\./i.test(id);
}

// Gemini 2.5 Flash-Lite takes a numeric thinkingBudget (0 = off). Gemini 3+
// replaced it with thinkingLevel; sending both is a 400, and 3.7/3.8 Flash
// reject the MINIMAL level, so LOW is the fastest level every 3.x Flash accepts.
// includeThoughts streams thought summaries while the model reasons — the SDK's
// chunk.text excludes them, but they tell the caller the stream is alive.
//
// Gemini 4 adds a fourth level, XHIGH, and removes MINIMAL entirely: every
// Gemini 4 model rejects MINIMAL. Hydrogen's provider default is HIGH, which
// is far too much hidden reasoning for a glance-and-go QnA answer, and its
// thinking tokens share maxOutputTokens, so a default-HIGH ask can eat the
// 1400/2800-token conversational cap and truncate the visible answer. Cue
// therefore always sets the level explicitly for Gemini 4: LOW on the fast
// tier, MEDIUM on Smart, and the same pair for LeetCode. XHIGH is deliberately
// never sent: it is for the hardest multi-step work only, and the pinned
// @google/genai 2.x SDK has no XHIGH enum value (it arrived in SDK 3.3.0).
// If XHIGH is ever needed, bump the SDK major first, then add it as an
// explicit opt-in, never as a tier default.
function geminiThinkingConfig(model, mode, smart) {
  if (!isGeminiThinkingModel(model)) return undefined;
  const leetcode = mode === 'leetcode';
  const major = geminiMajorVersion(model);
  if (major >= 4) {
    // Conversational modes (ask/say/assist/answerThis/transcribe) and
    // LeetCode alike: LOW fast, MEDIUM smart. Never MINIMAL, never the
    // provider's HIGH default.
    return { thinkingLevel: smart ? 'MEDIUM' : 'LOW', includeThoughts: true };
  }
  if (major >= 3) {
    if (leetcode) return { thinkingLevel: smart ? 'MEDIUM' : 'LOW', includeThoughts: true };
    if (defaultsToMinimalThinking(model)) {
      // Same model on both tiers would otherwise make Smart a no-op.
      return { thinkingLevel: smart ? 'HIGH' : 'MINIMAL', includeThoughts: true };
    }
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

// The system prompt as Anthropic text blocks, each ending in a cache
// breakpoint. `cachePrefixChars` marks how much of the prompt is identical on
// every ask (meeting document, résumé, job description): with a breakpoint
// there, a question of a different mode or category still reuses that part
// instead of missing the cache entirely. The second breakpoint keeps the old
// behavior for back-to-back asks whose whole prompt matches. Blocks below
// Anthropic's minimum cacheable size are simply not cached.
function anthropicSystemBlocks(system, cachePrefixChars) {
  if (!system) return undefined;
  const cached = (text) => ({ type: 'text', text, cache_control: { type: 'ephemeral' } });
  const split = Number(cachePrefixChars) || 0;
  if (split > 0 && split < system.length && system.slice(split).trim()) {
    return [cached(system.slice(0, split)), cached(system.slice(split))];
  }
  return [cached(system)];
}

async function streamAnthropic({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onUsage, cachePrefixChars }) {
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
  // The system prompt is marked cacheable: repeat requests within the 5-minute
  // cache window skip re-processing the cached part — faster first token and
  // ~90% cheaper on those tokens.
  const systemParam = anthropicSystemBlocks(system, cachePrefixChars);
  const stream = await client.messages.create({ model, max_tokens: maxTokens, system: systemParam, messages, stream: true });
  let full = '';
  const usage = {};
  for await (const ev of stream) {
    if (ev.type === 'content_block_delta' && ev.delta && ev.delta.type === 'text_delta') { full += ev.delta.text; onToken(ev.delta.text); }
    else if (ev.type === 'message_start' && ev.message && ev.message.usage) {
      const u = ev.message.usage;
      usage.cachedTokens = u.cache_read_input_tokens || 0;
      usage.promptTokens = (u.input_tokens || 0) + usage.cachedTokens + (u.cache_creation_input_tokens || 0);
    } else if (ev.type === 'message_delta' && ev.usage) {
      usage.outputTokens = ev.usage.output_tokens;
    }
  }
  if (onUsage && usage.promptTokens != null) onUsage(usage);
  return full;
}

async function streamGemini({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, onUsage, thinkingConfig }) {
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
  let usage = null;
  for await (const chunk of stream) {
    // The running totals arrive on the chunks; the last one seen is final.
    if (chunk && chunk.usageMetadata) usage = chunk.usageMetadata;
    const t = chunk && chunk.text;
    if (t) { full += t; onToken(t); }
    else if (onActivity) onActivity();
  }
  if (onUsage && usage) {
    onUsage({
      promptTokens: usage.promptTokenCount,
      // Non-zero means Gemini's implicit cache recognised the prompt prefix.
      cachedTokens: usage.cachedContentTokenCount || 0,
      outputTokens: usage.candidatesTokenCount,
      thoughtTokens: usage.thoughtsTokenCount
    });
  }
  return full;
}

const nanosToMs = (nanos) => (typeof nanos === 'number' ? Math.round(nanos / 1e6) : undefined);

async function streamOllama({ apiKey, model, system, turns, imageDataUrl, maxTokens, onToken, onActivity, onUsage, signal, numCtx }) {
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
          // Must match the value used to preload the model: Ollama reloads the
          // model whenever a request asks for a different context size.
          num_ctx: normalizeNotesContextTokens(numCtx),
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
  const handleLine = (line) => {
    if (!line.trim()) return;
    let data;
    try { data = JSON.parse(line); } catch (e) { return; }
    if (data.message && data.message.content) {
      full += data.message.content;
      onToken(data.message.content);
    }
    // The closing line carries Ollama's own counters. prompt_eval_ms is the
    // time spent reading the prompt: it drops sharply when the start of the
    // prompt was already in the model's cache from the previous request.
    if (data.done && onUsage) {
      onUsage({
        promptTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
        promptEvalMs: nanosToMs(data.prompt_eval_duration),
        evalMs: nanosToMs(data.eval_duration),
        loadMs: nanosToMs(data.load_duration)
      });
    }
  };
  for await (const chunk of response.body) {
    if (onActivity) onActivity();
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line
    for (const line of lines) handleLine(line);
  }
  handleLine(buffer);
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
  if (provider === 'gemini' && DEAD_GEMINI_MODEL_RE.test(model || '')) model = '';
  if (provider === 'anthropic' && RETIRED_ANTHROPIC_MODEL_RE.test(model || '')) model = '';
  if (!model) model = (tier === 'smart' && DEFAULT_SMART_MODELS[provider]) || DEFAULT_MODELS[provider] || '';
  // Optional model for Quick mode only; blank means Quick uses the tier model.
  let quickModel = String((models[provider] || {}).quick || '').trim();
  if (provider === 'gemini' && DEAD_GEMINI_MODEL_RE.test(quickModel)) quickModel = '';
  if (provider === 'anthropic' && RETIRED_ANTHROPIC_MODEL_RE.test(quickModel)) quickModel = '';
  const modelFor = (mode) => (settings.quick && QUICK_MODES.has(mode) && quickModel) || model;
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
    provider, model, quickModel, apiKey, baseURL,
    modelFor,
    ready,
    configurationError,
    // Pre-open the TCP+TLS connection to the provider while the screenshot is
    // being captured (or while the user is still typing). Fire-and-forget.
    warmup() {
      if (!ready) return;
      const target = warmupTarget();
      if (target && target.url) warmOrigin(target.url, target.nodeAgent);
    },
    // How long ago this provider's connection was last warmed or used (ms), or
    // null if never. Reported in CUE_PERF lines next to the first-token time.
    warmAgeMs() {
      const target = warmupTarget();
      return target && target.url ? warmAgeMs(target.url) : null;
    },
    async stream(params) {
      if (!ready) throw new Error(configurationError || `Complete the ${provider} provider settings.`);
      const isQuick = !!settings.quick && params.mode !== 'leetcode';
      const effectiveSmart = isQuick ? false : !!settings.smart;
      const activeModel = modelFor(params.mode);
      const args = { apiKey, baseURL, endpoint, model: activeModel, numCtx: settings.notesContextTokens, ...params, turns: sanitizeTurns(params.turns) };
      // Caller can pass maxTokens explicitly (tests); otherwise size the cap
      // to the mode. LeetCode needs a much larger budget than Assist.
      if (params.maxTokens == null) args.maxTokens = isQuick ? 1400 : tokenBudget(params.mode, effectiveSmart);
      // Fast tier + conversational mode: keep Gemini's hidden reasoning short.
      // LeetCode always keeps some thinking (answer depth), bounded so hidden
      // tokens cannot eat maxOutputTokens and cut the walkthrough off.
      args.thinkingConfig = provider === 'gemini'
        ? geminiThinkingConfig(activeModel, params.mode, effectiveSmart)
        : undefined;
      // Fast-tier GPT-5 / o-series: skip the long hidden reasoning pass. Smart
      // and LeetCode keep the provider default so hard problems stay deep.
      args.reasoningEffort = (provider === 'openai' || provider === 'azure')
        && !effectiveSmart
        && params.mode !== 'leetcode'
        && isReasoningChatModel(activeModel)
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
          const text = await dispatch({ ...args, onToken });
          const target = warmupTarget();
          if (target && target.url) noteOriginUse(target.url);
          return text;
        } catch (error) {
          if (!emitted && attempt < retryDelays.length && isOverloadedError(error)) {
            if (params.onActivity) params.onActivity();
            await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
            continue;
          }
          throw new Error(formatProviderErrorMessage(error, provider, activeModel));
        }
      }
    }
  };
}

module.exports = {
  createLLM,
  QUICK_MODES,
  formatProviderErrorMessage,
  isQuotaError,
  isOverloadedError,
  agentFor,
  CURRENT_GEMINI_DEFAULT,
  CURRENT_GEMINI_SMART_DEFAULT,
  DEFAULT_MODELS,
  DEFAULT_SMART_MODELS,
  FETCH_WARMUP_TTL_MS,
  isReasoningChatModel,
  tokenBudget,
  geminiThinkingConfig,
  isGeminiThinkingModel
};
