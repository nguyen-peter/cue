// Pure audio helpers between the microphone and the transcriber: the voice
// activity detector's framing, the long-speech cut point, and the 16k -> 24k
// resampler used by the OpenAI Realtime path.

const assert = require('node:assert/strict');
const test = require('node:test');
const { AdaptiveVAD } = require('../src/vad');
const { findQuietCut } = require('../src/wav');
const { Resampler16to24 } = require('../src/stt-streaming');

const SAMPLE_RATE = 16000;

function tone(samples, amplitude) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(amplitude, i * 2);
  return buffer;
}

function ramp(samples, start = 0, step = 3) {
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(start + i * step, i * 2);
  return buffer;
}

function samplesOf(buffer) {
  const out = [];
  for (let i = 0; i + 1 < buffer.length; i += 2) out.push(buffer.readInt16LE(i));
  return out;
}

// ── Voice activity detection ────────────────────────────────────────────────

function countFrames(vad, chunks) {
  let frames = 0;
  const original = vad._processFrame.bind(vad);
  vad._processFrame = (energy) => { frames += 1; original(energy); };
  for (const chunk of chunks) vad.processChunk(chunk);
  return frames;
}

test('the detector hears every sample when chunks are not a whole number of frames', () => {
  // 100ms chunks (1600 samples) hold 3⅓ frames of 480 samples each.
  const chunks = Array.from({ length: 30 }, () => tone(1600, 1000));
  const frames = countFrames(new AdaptiveVAD(), chunks);
  // 3 seconds of audio = 100 frames. Dropping each chunk's remainder gave 90.
  assert.equal(frames, 100);
});

test('speech end is detected at the same moment whatever the chunk size', () => {
  const durationsFor = (chunkSamples) => {
    const durations = [];
    const vad = new AdaptiveVAD({ onSpeechEnd: (ms) => durations.push(ms) });
    const audio = Buffer.concat([tone(SAMPLE_RATE, 1200), tone(SAMPLE_RATE, 0)]); // 1s speech, 1s silence
    for (let offset = 0; offset < audio.length; offset += chunkSamples * 2) {
      vad.processChunk(audio.subarray(offset, offset + chunkSamples * 2));
    }
    return durations;
  };
  assert.deepEqual(durationsFor(1600), durationsFor(480));
  assert.deepEqual(durationsFor(4096), durationsFor(480));
});

test('reset clears carried samples so a new session starts clean', () => {
  const vad = new AdaptiveVAD();
  vad.processChunk(tone(700, 1000)); // one frame plus 220 carried samples
  vad.reset();
  assert.equal(countFrames(vad, [tone(480, 0)]), 1);
});

// ── Long-speech cut point ───────────────────────────────────────────────────

test('findQuietCut lands inside the pause nearest the end', () => {
  const pcm = Buffer.concat([
    tone(SAMPLE_RATE * 3, 1000),            // 0.0s - 3.0s speech
    tone(SAMPLE_RATE * 0.2, 10),            // 3.0s - 3.2s pause
    tone(SAMPLE_RATE * 0.8, 1000)           // 3.2s - 4.0s speech
  ]);
  const cutSeconds = findQuietCut(pcm) / 2 / SAMPLE_RATE;
  assert.ok(cutSeconds > 3.0 && cutSeconds < 3.2, `cut at ${cutSeconds}s is outside the pause`);
  assert.equal(findQuietCut(pcm) % 2, 0, 'cut is sample-aligned');
});

test('findQuietCut ignores pauses older than the search window', () => {
  const pcm = Buffer.concat([
    tone(SAMPLE_RATE * 1, 1000),
    tone(SAMPLE_RATE * 0.2, 10),            // pause 3.8s before the end
    tone(SAMPLE_RATE * 3.8, 1000)
  ]);
  assert.equal(findQuietCut(pcm), pcm.length);
});

test('findQuietCut returns the full length for steady speech or very short audio', () => {
  assert.equal(findQuietCut(tone(SAMPLE_RATE * 4, 1000)), SAMPLE_RATE * 4 * 2);
  assert.equal(findQuietCut(tone(100, 1000)), 200);
  assert.equal(findQuietCut(Buffer.alloc(0)), 0);
});

// ── Resampler ───────────────────────────────────────────────────────────────

test('resampling in small chunks gives the same audio as resampling in one piece', () => {
  const audio = ramp(4800);
  const whole = samplesOf(new Resampler16to24().process(audio));

  for (const chunkSamples of [1600, 480, 333, 1]) {
    const resampler = new Resampler16to24();
    const pieces = [];
    for (let offset = 0; offset < audio.length; offset += chunkSamples * 2) {
      pieces.push(resampler.process(audio.subarray(offset, offset + chunkSamples * 2)));
    }
    const chunked = samplesOf(Buffer.concat(pieces));
    assert.deepEqual(chunked, whole.slice(0, chunked.length), `chunks of ${chunkSamples} samples diverge`);
    assert.ok(whole.length - chunked.length <= 2, 'at most the final interpolation is still pending');
  }
});

test('the resampler produces three samples for every two, on the original line', () => {
  // A straight line stays a straight line under linear interpolation.
  const out = samplesOf(new Resampler16to24().process(ramp(1000, 0, 3)));
  assert.ok(Math.abs(out.length - 1500) <= 2);
  out.forEach((value, i) => assert.equal(value, i * 2));
});

test('reset starts a new stream instead of interpolating from the previous one', () => {
  const resampler = new Resampler16to24();
  resampler.process(tone(101, 30000));
  resampler.reset();
  const out = samplesOf(resampler.process(tone(100, 0)));
  assert.ok(out.every((value) => value === 0));
});
