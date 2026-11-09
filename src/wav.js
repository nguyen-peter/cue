// Wrap raw Int16LE mono PCM in a WAV container so STT APIs accept it as a file.
function pcmToWav(pcm, sampleRate = 16000, channels = 1) {
  const dataSize = pcm.length;
  const byteRate = sampleRate * channels * 2;
  const blockAlign = channels * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);         // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

// Rough loudness gate so we don't ship silence to the STT API.
function rms16(pcm) {
  if (pcm.length < 2) return 0;
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) { const s = pcm.readInt16LE(i); sum += s * s; }
  return Math.sqrt(sum / n);
}

// Where to split speech that has run past the length limit: the byte offset of
// the quietest moment in the last `searchMs`, so the cut lands in a pause
// between words rather than through one. When no window is clearly quieter
// than the rest (continuous speech at a steady level) there is no good place,
// and the full length is returned so segments stay as long as allowed.
// Always sample-aligned, and never 0.
function findQuietCut(pcm, { sampleRate = 16000, searchMs = 2000, windowMs = 40 } = {}) {
  const bytesPerMs = (sampleRate * 2) / 1000;
  const windowBytes = Math.floor((windowMs * bytesPerMs) / 2) * 2;
  if (windowBytes < 2 || pcm.length < windowBytes * 4) return pcm.length;
  const searchBytes = Math.min(pcm.length, Math.floor((searchMs * bytesPerMs) / 2) * 2);
  const start = pcm.length - searchBytes;

  let quietest = Infinity;
  let quietestOffset = -1;
  let total = 0;
  let windows = 0;
  for (let offset = start; offset + windowBytes <= pcm.length; offset += windowBytes) {
    let energy = 0;
    for (let i = offset; i < offset + windowBytes; i += 2) {
      const sample = pcm.readInt16LE(i);
      energy += sample * sample;
    }
    total += energy;
    windows += 1;
    // "<=" prefers the later of two equally quiet windows: a longer segment.
    if (energy <= quietest) {
      quietest = energy;
      quietestOffset = offset;
    }
  }
  if (quietestOffset < 0 || windows < 2) return pcm.length;
  // Energy is amplitude squared: a quarter of the mean energy is half the
  // mean loudness. Anything less distinct than that is not a pause.
  if (quietest > (total / windows) * 0.25) return pcm.length;
  const cut = quietestOffset + Math.floor(windowBytes / 4) * 2;
  return cut > 0 ? cut : pcm.length;
}

module.exports = { pcmToWav, rms16, findQuietCut };
