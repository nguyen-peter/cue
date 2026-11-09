// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, agentFor, CURRENT_GEMINI_DEFAULT, geminiThinkingConfig } = require('./llm');

const BASE_VOCAB_TERMS = [
  'CI/CD', 'Docker', 'Kubernetes', 'Terraform', 'Jenkins', 'AWS', 'Azure', 'GCP',
  'CodeCommit', 'CodePipeline', 'CodeBuild', 'CodeDeploy', 'DevOps', 'SRE', 'microservices', 'deployment',
  'pipeline', 'container', 'orchestration', 'Ansible', 'Prometheus', 'Grafana', 'Helm', 'EKS', 'ECS', 'Lambda',
  'S3', 'EC2', 'IAM', 'GitHub Actions', 'GitLab', 'Kafka', 'PostgreSQL', 'Redis', 'MongoDB', 'REST API', 'gRPC'
];

function looksLikeHallucination(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return true;
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+$/u.test(trimmed)) return true;
  const withoutTags = trimmed
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!withoutTags) return true;
  const t = withoutTags.replace(/[.,!?…]+$/g, '').trim().toLowerCase();
  const artifacts = new Set([
    'thank you', 'thank you very much', 'thank you so much', 'thanks',
    'thank you for watching', 'thanks for watching', 'thank you for listening',
    'please subscribe', 'like and subscribe', 'subtitles by the amara org community',
    'bye-bye', 'bye bye', 'bye', 'you', 'okay', 'oh', 'uh', 'um', 'hmm', 'hm', 'ah', 'eh', 'mm'
  ]);
  if (artifacts.has(t)) return true;
  const clauses = withoutTags
    .toLowerCase()
    .split(/[.,!?…;:\-–—]+/)
    .map((c) => c.trim())
    .filter(Boolean);
  return clauses.length > 0 && clauses.every((c) => artifacts.has(c));
}

// ── Vocabulary ───────────────────────────────────────────────────────────────
// Names and jargon from the user's résumé, job description and meeting document
// bias transcription toward the right spelling. Slots are scarce (Deepgram
// boosts 50 terms; Whisper reads only the last ~224 tokens of its prompt), so
// the user's own terms are ranked and go first, and the generic tech list only
// fills what is left.
//
// Capitalized words are the only signal available without a dictionary, and
// most capitalized words in a résumé are not names: section headings
// ("Experience"), and the verb that starts each bullet ("Led", "Built").
const MAX_USER_TERMS = 40;
const MAX_VOCAB_PROMPT_CHARS = 850;
const MAX_GEMINI_HINT_TERMS = 30;

const VOCAB_STOPWORDS = new Set((
  // section headings and résumé boilerplate
  'summary experience skills education projects certifications objective profile references languages ' +
  'technical expertise additional professional work employment history present current responsibilities ' +
  'achievements awards publications interests contact email phone address ' +
  // months and days
  'january february march april may june july august september october november december ' +
  'jan feb mar apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday ' +
  // sentence starters
  'the this that these those and but for with from our your their when where what how why who you they ' +
  'will are was were has have not all any can must should please note section page also ' +
  // bullet-opening verbs
  'led built developed managed designed implemented created drove owned improved reduced increased delivered ' +
  'launched migrated automated collaborated worked piloted cut spearheaded architected engineered optimized ' +
  'maintained established partnered mentored conducted performed analyzed supported utilized leveraged ' +
  'responsible coordinated wrote used using achieved integrated deployed tested trained presented researched ' +
  'streamlined resolved configured monitored ' +
  // titles and degrees
  'senior junior lead staff principal intern engineer developer manager analyst assistant director associate ' +
  'consultant specialist university college bachelor bachelors master masters degree science computer ' +
  'engineering software research teaching application team company role'
).split(/\s+/));

const TERM_RE = /\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g;

// True when the word at `index` opens a sentence, line, or bullet — the one
// place a capital letter says nothing about whether the word is a name.
function opensSentence(text, index) {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) i--;
  if (i < 0) return true;
  return '\n\r.!?:;•*–—|(-'.includes(text[i]);
}

/**
 * The user's own terms, best first. A term ranks high when its shape marks it
 * as a name or acronym (EKS, ArgoCD, Node.js), when it is capitalized in the
 * middle of a sentence, or when it recurs. A word seen only at the start of a
 * sentence is kept as a low-ranked maybe (company names often open a résumé
 * line) unless it looks like a verb.
 */
function extractUserTerms(settings) {
  const s = settings || {};
  const text = [s.resumeText, s.jobDescription, s.contextDoc]
    .filter((part) => typeof part === 'string' && part)
    .join('\n');
  if (!text) return [];

  const seen = new Map(); // lowercase -> { term, count, mid, shaped, first }
  let match;
  TERM_RE.lastIndex = 0;
  while ((match = TERM_RE.exec(text)) !== null) {
    const term = match[1].replace(/\.+$/, '');
    if (term.length < 2 || /^[A-Z](?:\.[A-Z])+$/.test(term)) continue; // "B.S", "U.S"
    const key = term.toLowerCase();
    if (VOCAB_STOPWORDS.has(key)) continue;
    let entry = seen.get(key);
    if (!entry) {
      entry = {
        term,
        count: 0,
        mid: false,
        // acronym (AWS, EC2, OKRs) | inner capital (ArgoCD) | digit or symbol (Node.js)
        shaped: /^[A-Z][A-Z0-9]{1,5}s?$/.test(term) || /[a-z][A-Z]/.test(term) || /[0-9+#]/.test(term) || /[a-zA-Z]\.[a-zA-Z]/.test(term),
        first: match.index
      };
      seen.set(key, entry);
    }
    entry.count += 1;
    if (!opensSentence(text, match.index)) entry.mid = true;
  }

  const ranked = [];
  for (const entry of seen.values()) {
    const verbLike = /(?:ed|ing)$/.test(entry.term);
    if (!entry.shaped && !entry.mid && verbLike) continue; // "Refactored", "Shipping" at a bullet start
    const score = (entry.shaped ? 3 : 0) + (entry.mid ? 2 : 0) + Math.min(entry.count - 1, 2) + (!entry.shaped && !entry.mid ? 1 : 0);
    ranked.push({ term: entry.term, score, first: entry.first });
  }
  ranked.sort((a, b) => b.score - a.score || a.first - b.first);
  return ranked.slice(0, MAX_USER_TERMS).map((entry) => entry.term);
}

function baseTermsNotIn(userTerms) {
  const taken = new Set(userTerms.map((term) => term.toLowerCase()));
  return BASE_VOCAB_TERMS.filter((term) => !taken.has(term.toLowerCase()));
}

// Most important first: the user's ranked terms, then the generic tech list.
// Deepgram keeps the first 50 of these as nova-3 keyterms.
function buildVocabTerms(settings) {
  const userTerms = extractUserTerms(settings);
  return userTerms.concat(baseTermsNotIn(userTerms));
}

// Whisper conditions on its prompt like preceding text and only reads the END
// of it, so the order is reversed here: generic terms first, the user's best
// terms last, and anything over the cap is dropped from the front.
function buildVocabPrompt(settings) {
  const userTerms = extractUserTerms(settings);
  const terms = baseTermsNotIn(userTerms).concat(userTerms.slice().reverse());
  let prompt = terms.join(', ');
  while (prompt.length > MAX_VOCAB_PROMPT_CHARS && terms.length > 1) {
    terms.shift();
    prompt = terms.join(', ');
  }
  return prompt.slice(-MAX_VOCAB_PROMPT_CHARS);
}

const GEMINI_TRANSCRIBE_INSTRUCTION =
  'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.';

// Gemini has no vocabulary parameter, so the user's terms ride along in the
// instruction. Only the user's own terms are sent (Gemini already knows the
// generic ones), and the wording limits them to spelling so they are not
// written into audio where they were never said.
function buildGeminiTranscribeInstruction(settings) {
  const userTerms = extractUserTerms(settings).slice(0, MAX_GEMINI_HINT_TERMS);
  if (!userTerms.length) return GEMINI_TRANSCRIBE_INSTRUCTION;
  return GEMINI_TRANSCRIBE_INSTRUCTION +
    ' The speakers may mention these names and terms; use these spellings when one is actually spoken, and never add a word that was not said: ' +
    userTerms.join(', ') + '.';
}

// Thinking is wasted on transcription and delays every utterance. Use the same
// per-model rule as the fast chat tier, without the thought summaries.
function geminiTranscribeConfig(model) {
  const thinking = geminiThinkingConfig(model, 'transcribe', false);
  if (!thinking) return undefined;
  const { includeThoughts, ...thinkingConfig } = thinking;
  return { thinkingConfig };
}

async function transcribeOpenAI(client, wav, model, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    language: 'en',
    temperature: 0,
    prompt: prompt || ''
  });
  return (res.text || '').trim();
}

async function transcribeGemini(ai, wav, instruction) {
  const request = {
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: instruction || GEMINI_TRANSCRIBE_INSTRUCTION },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  };
  const config = geminiTranscribeConfig(CURRENT_GEMINI_DEFAULT);
  if (config) request.config = config;
  const res = await ai.models.generateContent(request);
  return ((res && res.text) || '').trim();
}

// One instance serves a whole listening session: the vocabulary is scanned and
// the provider clients are created once, not per utterance, and the quota
// back-off below survives from one utterance to the next.
function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const geminiInstruction = buildGeminiTranscribeInstruction(settings);

  const clients = new Map();
  const cached = (key, create) => {
    if (!clients.has(key)) clients.set(key, create());
    return clients.get(key);
  };
  // Shares the LLM layer's keep-alive agent: batch transcription runs every
  // utterance while listening, which keeps the provider socket warm — so an
  // Assist request mid-meeting skips the TLS handshake entirely.
  const openaiClient = (apiKey, baseURL) => cached(`openai|${baseURL || ''}`, () => {
    const OpenAI = require('openai');
    return new OpenAI({ apiKey, baseURL, httpAgent: agentFor(baseURL || 'https://api.openai.com') });
  });
  const geminiClient = (apiKey) => cached('gemini', () => {
    const { GoogleGenAI } = require('@google/genai');
    return new GoogleGenAI({ apiKey });
  });

  const chain = [];
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(openaiClient(keys.openai), wav, settings.sttModel, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(openaiClient(keys.groq, 'https://api.groq.com/openai/v1'), wav, 'whisper-large-v3-turbo', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(geminiClient(keys.gemini), wav, geminiInstruction) });
  }
  if (keys.openai && chain.length > 1) chain.unshift(chain.splice(chain.findIndex((c) => c.p === 'openai'), 1)[0]);

  let disabledUntil = 0;
  let lastProvider = null;

  return {
    available: chain.length > 0,
    providers: chain.map((c) => c.p),
    async transcribe(pcm) {
      if (!chain.length || !pcm || pcm.length < 3200) return { text: '' };
      const now = Date.now();
      if (disabledUntil && now < disabledUntil) return { text: '', error: { provider: lastProvider, message: `Temporary ${lastProvider || 'provider'} quota or rate-limit; waiting 30s before retrying.` } };
      const wav = pcmToWav(pcm, 16000, 1);
      let lastErr = null;
      for (const c of chain) {
        try {
          const text = await c.fn(wav);
          disabledUntil = 0;
          lastProvider = c.p;
          if (looksLikeHallucination(text)) return { text: '', provider: c.p };
          return { text, provider: c.p };
        } catch (e) {
          // Shares detection/wording with the LLM error path (src/llm.js) so a
          // 404 (dead/misspelled model) or 429 (quota) reads the same whether it
          // came from a chat request or a transcription request.
          const quota = isQuotaError(e);
          const message = formatProviderErrorMessage(e, c.p);
          lastErr = { status: e && e.status, code: e && e.code, message, provider: c.p };
          if (quota) {
            lastProvider = c.p;
            disabledUntil = now + 30000;
            break;
          }
        }
      }
      return { text: '', error: lastErr };
    }
  };
}

module.exports = {
  createSTT,
  looksLikeHallucination,
  buildVocabPrompt,
  buildVocabTerms,
  extractUserTerms,
  buildGeminiTranscribeInstruction,
  geminiTranscribeConfig
};
