// Vocabulary biasing: which of the user's words are worth a scarce slot, and in
// what order each transcription provider needs them. Also pins the request cue
// sends when Gemini is the transcriber.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

let capturedGeminiRequest = null;
let geminiClientsCreated = 0;
const originalModuleLoad = Module._load;
Module._load = function loadWithGeminiStub(request, parent, isMain) {
  if (request === '@google/genai') {
    return {
      GoogleGenAI: class FakeGoogleGenAI {
        constructor() {
          geminiClientsCreated += 1;
          this.models = {
            generateContent: async (generateRequest) => {
              capturedGeminiRequest = generateRequest;
              return { text: ' We moved the ledger to Kubernetes. ' };
            }
          };
        }
      }
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const { createSTT, buildVocabTerms, buildVocabPrompt, extractUserTerms, buildGeminiTranscribeInstruction } = require('../src/stt');
const { CURRENT_GEMINI_DEFAULT } = require('../src/llm');
const { DeepgramStreamingSTT } = require('../src/stt-streaming');

test.after(() => { Module._load = originalModuleLoad; });
test.beforeEach(() => { capturedGeminiRequest = null; geminiClientsCreated = 0; });

const RESUME = [
  'Jordan Rivera',
  'jordan@example.com',
  'Summary',
  'Platform engineer with 8 years building CI/CD and cloud infrastructure.',
  'Experience',
  'Ecolab St. Paul, MN',
  '- Led the migration of 40 services to Kubernetes on EKS using Terraform and ArgoCD.',
  '- Built a Datadog dashboard used by the Zephyrix team.',
  '- Refactored the ledger service in Go.',
  '- Reduced deploy time by 60% with ArgoCD.',
  'Skills',
  'Kubernetes, Terraform, AWS, Python, ArgoCD, Datadog, Node.js',
  'Education',
  'B.S. Computer Science, State University'
].join('\n');

test('section headings, bullet-opening verbs and degrees are not treated as names', () => {
  const terms = extractUserTerms({ resumeText: RESUME });
  for (const noise of ['Summary', 'Experience', 'Skills', 'Education', 'Led', 'Built', 'Refactored', 'Reduced', 'Computer', 'Science', 'University', 'B.S']) {
    assert.ok(!terms.includes(noise), `${noise} should not take a vocabulary slot`);
  }
});

test('names, acronyms and product spellings are kept, best first', () => {
  const terms = extractUserTerms({ resumeText: RESUME });
  for (const wanted of ['ArgoCD', 'EKS', 'Kubernetes', 'Terraform', 'Datadog', 'Zephyrix', 'Rivera', 'Node.js', 'Ecolab']) {
    assert.ok(terms.includes(wanted), `${wanted} should be kept`);
  }
  // ArgoCD: distinctive spelling, mid-sentence, repeated — outranks a word seen
  // once at the start of a line.
  assert.ok(terms.indexOf('ArgoCD') < terms.indexOf('Ecolab'));
  assert.ok(terms.indexOf('EKS') < terms.indexOf('Ecolab'));
});

test('the user\'s terms come before the generic list, so Deepgram\'s 50 slots go to them first', () => {
  const settings = { resumeText: RESUME };
  const terms = buildVocabTerms(settings);
  const userTerms = extractUserTerms(settings);
  assert.deepEqual(terms.slice(0, userTerms.length), userTerms);
  assert.ok(terms.includes('Prometheus'), 'generic terms still fill the remaining slots');
  assert.equal(new Set(terms.map((t) => t.toLowerCase())).size, terms.length, 'no term is listed twice');

  const keyterms = new DeepgramStreamingSTT('k', { keyterms: terms }).buildQueryParams().getAll('keyterm');
  for (const wanted of userTerms) assert.ok(keyterms.includes(wanted), `${wanted} must reach Deepgram`);
});

test('a large document cannot push the user\'s best terms out of Deepgram\'s slots', () => {
  const filler = Array.from({ length: 200 }, (_, i) => `The Widget${i} module calls Gadget${i}.`).join(' ');
  const terms = buildVocabTerms({ resumeText: 'We run everything on ArgoCD. ArgoCD deploys to EKS. EKS hosts ArgoCD.', contextDoc: filler });
  assert.ok(terms.slice(0, 50).includes('ArgoCD'));
  assert.ok(terms.slice(0, 50).includes('EKS'));
});

test('the Whisper prompt ends with the user\'s best terms, because Whisper only reads the end', () => {
  const settings = { resumeText: RESUME };
  const prompt = buildVocabPrompt(settings);
  const best = extractUserTerms(settings)[0];
  assert.ok(prompt.endsWith(best), `prompt should end with ${best}`);
  assert.ok(prompt.indexOf('Docker') < prompt.indexOf(best), 'generic terms come first');
});

test('when the Whisper prompt is over its cap, generic terms are dropped before the user\'s', () => {
  // Long names, so 40 user terms alone exceed the 850-character cap.
  const filler = Array.from({ length: 200 }, (_, i) => `The WidgetOrchestrationService${i} module calls GadgetReplicationWorker${i}.`).join(' ');
  const settings = { resumeText: 'We deploy with ArgoCD to EKS. Every repo syncs through ArgoCD on EKS.', contextDoc: filler };
  const prompt = buildVocabPrompt(settings);
  assert.ok(prompt.length <= 850);
  assert.ok(prompt.includes('ArgoCD'));
  assert.ok(prompt.includes('EKS'));
  assert.ok(!prompt.includes('Docker'), 'the generic list is what gets dropped');
});

// ── Gemini as the transcriber ───────────────────────────────────────────────

test('Gemini transcription uses the current default model with thinking kept minimal', async () => {
  const stt = createSTT({ sttProvider: 'gemini', apiKeys: { gemini: 'k' } });
  const result = await stt.transcribe(Buffer.alloc(6400, 1));
  assert.deepEqual(result, { text: 'We moved the ledger to Kubernetes.', provider: 'gemini' });
  assert.equal(capturedGeminiRequest.model, CURRENT_GEMINI_DEFAULT);
  assert.deepEqual(capturedGeminiRequest.config, { thinkingConfig: { thinkingLevel: 'MINIMAL' } });
  // Gemini 3.5+ deprecates sampling parameters; later generations reject them.
  assert.equal(capturedGeminiRequest.config.temperature, undefined);
  assert.equal(capturedGeminiRequest.contents[0].parts[1].inlineData.mimeType, 'audio/wav');
});

test('with no résumé or document the Gemini instruction is unchanged', () => {
  const instruction = buildGeminiTranscribeInstruction({});
  assert.match(instruction, /^Transcribe this audio verbatim\./);
  assert.doesNotMatch(instruction, /spellings/);
});

test('the user\'s terms reach Gemini as spelling hints only', async () => {
  const settings = { sttProvider: 'gemini', apiKeys: { gemini: 'k' }, resumeText: RESUME };
  await createSTT(settings).transcribe(Buffer.alloc(6400, 1));
  const instruction = capturedGeminiRequest.contents[0].parts[0].text;
  assert.match(instruction, /ArgoCD/);
  assert.match(instruction, /Zephyrix/);
  assert.match(instruction, /never add a word that was not said/);
  assert.doesNotMatch(instruction, /Prometheus/, 'the generic list is not sent to Gemini');
});

test('one transcriber reuses its provider client across utterances', async () => {
  const stt = createSTT({ sttProvider: 'gemini', apiKeys: { gemini: 'k' } });
  await stt.transcribe(Buffer.alloc(6400, 1));
  await stt.transcribe(Buffer.alloc(6400, 1));
  await stt.transcribe(Buffer.alloc(6400, 1));
  assert.equal(geminiClientsCreated, 1);
});
