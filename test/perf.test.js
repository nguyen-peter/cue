const assert = require('node:assert/strict');
const test = require('node:test');
const { createTrace, logPerf, perfEnabled } = require('../src/perf');

function clock(times) {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

test('timing is off unless CUE_PERF is set', () => {
  assert.equal(perfEnabled({}), false);
  assert.equal(perfEnabled({ CUE_PERF: '0' }), false);
  assert.equal(perfEnabled({ CUE_PERF: 'false' }), false);
  assert.equal(perfEnabled({ CUE_PERF: '1' }), true);
});

test('a disabled trace does nothing and prints nothing', () => {
  const lines = [];
  const trace = createTrace('qna', { mode: 'ask' }, { log: (line) => lines.push(line), env: {} });
  assert.equal(trace.enabled, false);
  trace.mark('first_token');
  trace.set('prompt_tokens', 10);
  trace.end();
  logPerf('stt', { channel: 'them' }, { log: (line) => lines.push(line), env: {} });
  assert.deepEqual(lines, []);
});

test('an enabled trace prints identity, timings in order, facts, and the total', () => {
  const lines = [];
  const trace = createTrace('qna', { mode: 'ask', provider: 'gemini' }, {
    log: (line) => lines.push(line),
    env: { CUE_PERF: '1' },
    now: clock([1000, 1004, 1612.4, 2894])
  });
  trace.mark('request_sent');
  trace.mark('first_token');
  trace.set('prompt_tokens', 3310);
  trace.set('cached_tokens', 2816);
  trace.set('skipped', undefined);
  trace.end();
  assert.deepEqual(lines, ['[perf] qna mode=ask provider=gemini request_sent=4ms first_token=612ms prompt_tokens=3310 cached_tokens=2816 total=1894ms']);
});

test('markOnce records only the first occurrence, and end() prints once', () => {
  const lines = [];
  const trace = createTrace('notes', {}, { log: (line) => lines.push(line), env: { CUE_PERF: '1' }, now: clock([0, 10, 20, 30]) });
  trace.markOnce('first_token');
  trace.markOnce('first_token');
  trace.end('error');
  trace.end('error');
  assert.deepEqual(lines, ['[perf] notes first_token=10ms total=20ms status=error']);
});

test('logPerf prints one line of facts and omits empty ones', () => {
  const lines = [];
  logPerf('stt', { mode: 'batch', channel: 'them', audio_ms: 2400, since_speech_end_ms: undefined, provider: 'gemini' }, { log: (line) => lines.push(line), env: { CUE_PERF: '1' } });
  assert.deepEqual(lines, ['[perf] stt mode=batch channel=them audio_ms=2400 provider=gemini']);
});
