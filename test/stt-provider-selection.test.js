const assert = require('node:assert/strict');
const test = require('node:test');
const { createSTT } = require('../src/stt');
const { createStreamingSTT } = require('../src/stt-streaming');

const callbacks = {
  onTranscript() {},
  onInterim() {},
  onError() {},
  onStatusChange() {}
};

test('explicit local mode never constructs a cloud fallback', () => {
  const settings = {
    sttProvider: 'local',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key', deepgram: 'deepgram-key' }
  };
  assert.equal(createSTT(settings).available, false);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'local',
    instance: null
  });
});

test('explicit cloud selection does not cross-fallback to another provider', () => {
  const openai = createSTT({
    sttProvider: 'openai',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  const gemini = createSTT({
    sttProvider: 'gemini',
    apiKeys: { openai: 'openai-key', gemini: 'gemini-key' }
  });
  assert.deepEqual(openai.providers, ['openai']);
  assert.deepEqual(gemini.providers, ['gemini']);
});

test('explicit Groq selection transcribes with Groq only, in batch mode', () => {
  const settings = {
    sttProvider: 'groq',
    apiKeys: { groq: 'groq-key', openai: 'openai-key', deepgram: 'deepgram-key' }
  };
  // Even with OpenAI/Deepgram keys present, an explicit Groq choice wins —
  // and it must not be promoted away by the OpenAI-first auto ordering.
  assert.deepEqual(createSTT(settings).providers, ['groq']);
  assert.deepEqual(createStreamingSTT(settings, 'you', callbacks), {
    type: 'batch',
    provider: 'groq',
    instance: null
  });
});

test('Groq without a key reports transcription unavailable instead of failing', () => {
  const stt = createSTT({ sttProvider: 'groq', apiKeys: {} });
  assert.equal(stt.available, false);
});
