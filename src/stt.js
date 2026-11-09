// Speech-to-text factory. Decoupled from the LLM provider because Anthropic has
// no audio API — we transcribe with whatever audio-capable key is available, and
// fall back across providers. Returns { text, provider } or { text:'', error }.
const { pcmToWav } = require('./wav');
const { formatProviderErrorMessage, isQuotaError, agentFor, CURRENT_GEMINI_DEFAULT } = require('./llm');

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

// Base tech vocabulary plus proper nouns mined from the user's résumé, job
// description, and meeting document — company names, tools, acronyms. Used two
// ways: joined into a Whisper prompt (batch mode) and as Deepgram nova-3
// keyterms (streaming mode).
function buildVocabTerms(settings) {
  const s = settings || {};
  const text = (s.resumeText || '') + ' ' + (s.jobDescription || '') + ' ' + (s.contextDoc || '');
  const proper = Array.from(new Set(text.match(/\b([A-Z][a-zA-Z0-9+.#]{2,}|[A-Z]{2,6})\b/g) || []));
  return BASE_VOCAB_TERMS.concat(proper.slice(0, 60));
}

function buildVocabPrompt(settings) {
  let prompt = buildVocabTerms(settings).join(', ');
  if (prompt.length > 850) prompt = prompt.slice(0, 850);
  return prompt;
}

async function transcribeOpenAI(apiKey, wav, model, baseURL, prompt) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  // Shares the LLM layer's keep-alive agent: batch transcription flushes every
  // ~1s while listening, which keeps the provider socket warm — so an Assist
  // request mid-meeting skips the TLS handshake entirely.
  const client = new OpenAI({ apiKey, baseURL, httpAgent: agentFor(baseURL || 'https://api.openai.com') });
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

async function transcribeGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

function createSTT(settings) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const vocabPrompt = buildVocabPrompt(settings);
  const chain = [];
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    chain.push({ p: 'openai', fn: (wav) => transcribeOpenAI(keys.openai, wav, settings.sttModel, undefined, vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'groq') && keys.groq) {
    chain.push({ p: 'groq', fn: (wav) => transcribeOpenAI(keys.groq, wav, 'whisper-large-v3-turbo', 'https://api.groq.com/openai/v1', vocabPrompt) });
  }
  if ((selectedProvider === 'auto' || selectedProvider === 'gemini') && keys.gemini) {
    chain.push({ p: 'gemini', fn: (wav) => transcribeGemini(keys.gemini, wav) });
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

module.exports = { createSTT, looksLikeHallucination, buildVocabPrompt, buildVocabTerms };
