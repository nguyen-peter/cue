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
  // Context window (tokens) for the local Ollama model that writes Notes.
  // Larger lets it read more of the notes per update, at the cost of speed and
  // memory. See notesBudget() in src/notes.js.
  notesContextTokens: 4096,
  // quick: optional model for Quick mode only; blank uses the Fast model.
  models: {
    openai: { fast: 'gpt-4o-mini', smart: 'gpt-4o', quick: '' },
    // Kept in sync with DEFAULT_MODELS / DEFAULT_SMART_MODELS in src/llm.js,
    // which also explains why these ids were chosen and when they were checked.
    anthropic: { fast: 'claude-haiku-5-5', smart: 'claude-sonnet-5-5', quick: '' },
    gemini: { fast: 'gemini-3.5-flash-lite', smart: 'gemini-3.8-flash', quick: '' },
    custom: { fast: '', smart: '', quick: '' },
    ollama: { fast: 'llama3.2', smart: 'llama3.3', quick: '' },
    groq: { fast: 'llama-3.1-8b-instant', smart: 'llama-3.3-70b-versatile', quick: '' },
    minimax: { fast: 'MiniMax-M2.7', smart: 'MiniMax-M3', quick: '' },
    azure: { fast: 'gpt-4o-mini', smart: 'gpt-4o', quick: '' }
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
