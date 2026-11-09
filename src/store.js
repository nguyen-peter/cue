// Simple JSON-file settings store (avoids native modules so `npm install` stays clean).
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { normalizeBaseUrl } = require('./openai-compatible');

const FILE = path.join(app.getPath('userData'), 'cue-data.json');

// Cap on the user's custom response rules. Generous but bounded: anything longer
// should live in a real prompt file, not in a settings field.
const MAX_AI_RULES_CHARS = 2000;
// Coding-solve instructions replace a whole system prompt, so they get more room.
const MAX_CODING_INSTRUCTIONS_CHARS = 8000;

const DEFAULTS = {
  provider: 'openai',
  sttProvider: 'auto',
  localWhisper: {
    modelId: 'base.en',
    language: 'auto',
    threads: 0
  },
  smart: false,
  quick: false,
  baseUrl: '',
  minimaxRegion: 'global_en',
  apiKeys: { openai: '', anthropic: '', gemini: '', deepgram: '', custom: '', ollama: '', groq: '', minimax: '' , azure: '' },
  azureEndpoint: '',
  // Tab 2: Profile
  resumeText: '',
  jobDescription: '',
  // Tab 3: Interview Prep
  starStories: '',       // 3-5 behavioral STAR stories in plain English
  whyCompany: '',        // Why do you want to work here?
  whyLeaving: '',        // Why are you leaving your current job?
  workStyle: '',         // How you work, decision-making style, values
  // Tab 4: Q&A
  salaryTarget: '',      // e.g. "$150k-$180k base + equity"
  questionsToAsk: '',    // Questions to ask the interviewer
  // Tab 5: Style — custom response rules
  // The user writes how the AI should write: e.g. "no em-dashes", "use bullet
  // points", "casual tone". Applied to every LLM mode EXCEPT LeetCode (kept
  // strict for coding problems).
  aiRules: '',
  // Persona / instructions that apply ONLY to the Assist feature. Lets the user
  // say e.g. "answer as a senior C++ engineer" without affecting other modes.
  assistContext: '',
  // Instructions for coding solves (Ctrl/Cmd+H). Empty = cue's built-in
  // default; Settings → Coding shows that default pre-filled for editing.
  codingInstructions: '',
  // Window position + size (size is set once the user drags the resize grip)
  windowX: null,
  windowY: null,
  windowW: null,
  windowH: null,
  phoneToken: '',
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o' },
    anthropic: { fast: 'claude-3-5-haiku-latest', smart: 'claude-3-5-sonnet-latest' },
    // Kept in sync with CURRENT_GEMINI_DEFAULT in src/llm.js — gemini-2.0-flash
    // (the previous default here) was retired by Google on 2026-03-03 and 404s
    // on every request. gemini-2.5-flash is current and free-tier available.
    gemini: { fast: 'gemini-2.5-flash', smart: 'gemini-2.5-flash' },
    custom: { fast: '', smart: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o' }
  }
};

let data = null;
let lastMtimeMs = 0;

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(over || {})) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], over[k]);
    } else {
      if ((k === 'aiRules' || k === 'assistContext') && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_AI_RULES_CHARS);
      } else if (k === 'codingInstructions' && typeof over[k] === 'string') {
        out[k] = over[k].slice(0, MAX_CODING_INSTRUCTIONS_CHARS);
      } else {
        out[k] = over[k];
      }
    }
  }
  return out;
}

function load() {
  try {
    const stat = fs.statSync(FILE);
    if (data && stat.mtimeMs === lastMtimeMs) return data;
    data = deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8')));
    lastMtimeMs = stat.mtimeMs;
  } catch {
    if (!data) data = deepMerge(DEFAULTS, {});
  }
  return data;
}
function save() {
  try {
    fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
    try { lastMtimeMs = fs.statSync(FILE).mtimeMs; } catch (_) {}
  } catch (e) { /* ignore */ }
}

module.exports = {
  MAX_AI_RULES_CHARS,
  MAX_CODING_INSTRUCTIONS_CHARS,
  getSettings() { return load(); },
  setSettings(patch) {
    load();
    const nextSettings = deepMerge(data, patch || {});
    nextSettings.baseUrl = normalizeBaseUrl(nextSettings.baseUrl);
    data = nextSettings;
    save();
    return data;
  }
};
