const assert = require('node:assert/strict');
const test = require('node:test');
const { UtteranceSegmenter } = require('../src/utterance-segmenter');

const FRAME_SAMPLES = 480;
const FRAME_BYTES = FRAME_SAMPLES * 2;

function frame(amplitude) {
  const buffer = Buffer.alloc(FRAME_BYTES);
  for (let offset = 0; offset < buffer.length; offset += 2) buffer.writeInt16LE(amplitude, offset);
  return buffer;
}

function pushFrames(segmenter, amplitude, count) {
  for (let index = 0; index < count; index += 1) segmenter.push(frame(amplitude));
}

test('includes pre-roll and emits after the configured trailing silence', () => {
  const utterances = [];
  const speechStates = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'you',
    onSpeechState: (_channel, speaking) => speechStates.push(speaking),
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });

  pushFrames(segmenter, 0, 10);
  pushFrames(segmenter, 1200, 8);
  pushFrames(segmenter, 0, 18);

  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].length >= FRAME_BYTES * 30);
  assert.deepEqual(speechStates, [true, false]);
});

test('flushes a final active utterance when capture stops', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'them',
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });
  pushFrames(segmenter, 1000, 8);
  segmenter.stop();
  assert.equal(utterances.length, 1);
  assert.ok(utterances[0].length >= FRAME_BYTES * 8);
});

test('splits long speech into bounded segments that neither overlap nor drop audio', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'you',
    preRollMs: 60,
    minUtteranceMs: 30,
    maxUtteranceMs: 300,
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });
  pushFrames(segmenter, 1000, 24);
  segmenter.stop();

  // Steady speech has no pause to cut at, so segments run to the full limit.
  assert.equal(utterances.length, 3);
  assert.equal(utterances[0].length, FRAME_BYTES * 10);
  assert.equal(utterances[1].length, FRAME_BYTES * 10);
  assert.ok(utterances.every((pcm) => pcm.length <= FRAME_BYTES * 10));
  // Every pushed sample is transcribed exactly once.
  const total = utterances.reduce((sum, pcm) => sum + pcm.length, 0);
  assert.equal(total, FRAME_BYTES * 24);
});

test('splits over-long speech at a pause instead of mid-word', () => {
  const utterances = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'you',
    preRollMs: 60,
    minUtteranceMs: 30,
    maxUtteranceMs: 600, // 20 frames
    // A long hangover so the brief dip below is not treated as end of speech.
    vadOptions: { silenceFrames: 40 },
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });
  pushFrames(segmenter, 1000, 14);
  pushFrames(segmenter, 20, 2);   // a short pause between words, frames 15-16
  pushFrames(segmenter, 1000, 14);
  segmenter.stop();

  assert.equal(utterances.length, 2);
  // The first segment ends inside the pause (frames 15-16), not at frame 20.
  assert.ok(utterances[0].length > FRAME_BYTES * 14, 'cut is after the last loud frame before the pause');
  assert.ok(utterances[0].length < FRAME_BYTES * 16, 'cut is before speech resumes');
  const total = utterances.reduce((sum, pcm) => sum + pcm.length, 0);
  assert.equal(total, FRAME_BYTES * 30, 'no audio is duplicated or lost at the boundary');
});

test('cancels a brief noise spike below minSpeechFrames without staying stuck collecting silence', () => {
  const utterances = [];
  const speechStates = [];
  const segmenter = new UtteranceSegmenter({
    channel: 'you',
    onSpeechState: (_channel, speaking) => speechStates.push(speaking),
    onUtterance: (_channel, pcm) => utterances.push(pcm)
  });

  // 1-frame click followed by silence must cancel collection and reset speaking state
  pushFrames(segmenter, 1200, 1);
  pushFrames(segmenter, 0, 20);
  assert.equal(segmenter.collecting, false);
  assert.equal(utterances.length, 0);
  assert.deepEqual(speechStates, [true, false]);
});
