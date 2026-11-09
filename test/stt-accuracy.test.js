const test = require('node:test');
const assert = require('node:assert');
const { looksLikeHallucination, buildVocabPrompt, buildVocabTerms } = require('../src/stt');
const { DeepgramStreamingSTT } = require('../src/stt-streaming');

test('looksLikeHallucination drops Whisper silence artifacts', () => {
  [
    '',
    '   ',
    'Thank you for watching.',
    'thanks for watching',
    'Bye-bye!',
    '👍👍',
    'Thank you. Thank you.',
    'Thank you, thank you, thank you!',
    '[BLANK_AUDIO]',
    '(blank audio) Thank you.'
  ].forEach((s) => {
    assert.equal(looksLikeHallucination(s), true, JSON.stringify(s));
  });
});

test('looksLikeHallucination keeps real speech', () => {
  ['Tell me about your experience with Kubernetes.', 'You know, I led the migration.'].forEach((s) => {
    assert.equal(looksLikeHallucination(s), false, JSON.stringify(s));
  });
});

test('buildVocabPrompt seeds base vocab and resume proper nouns, capped', () => {
  const p = buildVocabPrompt({ resumeText: 'Optum EKS Terraform', jobDescription: 'AWS SRE' });
  assert.ok(p.includes('Kubernetes'));
  assert.ok(p.includes('Optum'));
  assert.ok(p.length <= 850);
  assert.ok(buildVocabPrompt(undefined).length > 0);
  assert.ok(buildVocabPrompt({ resumeText: 'Xyzzy '.repeat(4000) }).length <= 850);
});

test('buildVocabTerms returns base vocab plus resume/JD proper nouns as a list', () => {
  const terms = buildVocabTerms({ resumeText: 'Optum EKS', jobDescription: 'Datadog SRE' });
  assert.ok(terms.includes('Kubernetes'));
  assert.ok(terms.includes('Optum'));
  assert.ok(terms.includes('Datadog'));
  assert.ok(Array.isArray(buildVocabTerms(undefined)));
});

test('Deepgram session boosts vocabulary via nova-3 keyterms, capped at 50', () => {
  const d = new DeepgramStreamingSTT('k', { keyterms: ['Optum', 'Kubernetes', '  ', null] });
  const params = d.buildQueryParams();
  assert.deepEqual(params.getAll('keyterm'), ['Optum', 'Kubernetes']);
  assert.equal(params.get('model'), 'nova-3');

  const many = new DeepgramStreamingSTT('k', { keyterms: Array.from({ length: 80 }, (_, i) => 'term' + i) });
  assert.equal(many.buildQueryParams().getAll('keyterm').length, 50);
});

test('Deepgram session without keyterms sends none (no key configured yet)', () => {
  const d = new DeepgramStreamingSTT('k', {});
  assert.deepEqual(d.buildQueryParams().getAll('keyterm'), []);
});

test('Deepgram accumulates is_final segments into one turn at speech_final', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'Tell me about' }] } });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'your experience' }] } });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'with Kubernetes.' }] } });
  assert.deepEqual(finals, ['Tell me about your experience with Kubernetes.']);
});

test('Deepgram flushes pending segments on UtteranceEnd when speech_final never arrives', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, channel: { alternatives: [{ transcript: 'hello there' }] } });
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there']);
  d._handleMessage({ type: 'UtteranceEnd' });
  assert.deepEqual(finals, ['hello there'], 'no duplicate emit on a second UtteranceEnd');
});

test('Deepgram drops hallucinated finals', () => {
  const finals = [];
  const d = new DeepgramStreamingSTT('k', { onTranscript: (t) => finals.push(t) });
  d._handleMessage({ type: 'Results', is_final: true, speech_final: true, channel: { alternatives: [{ transcript: 'Thank you.' }] } });
  assert.deepEqual(finals, []);
});
