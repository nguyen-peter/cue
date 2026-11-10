// Shared transcript formatting for every prompt cue builds (Q&A and Notes).
//
// Speech-to-text delivers one spoken sentence as several short turns. Sending
// each fragment as its own "Them: ..." line costs a label and a line break per
// fragment and hands the model broken sentences, so consecutive turns from the
// same speaker are joined into one line first.

function speakerLabel(channel) {
  return channel === 'them' ? 'Them' : 'You';
}

/** Join consecutive same-speaker turns. Returns [{ channel, text }]. */
function mergeSpeakerTurns(turns) {
  const merged = [];
  for (const turn of turns || []) {
    const text = String((turn && turn.text) || '').trim();
    if (!text) continue;
    const channel = turn.channel === 'them' ? 'them' : 'you';
    const last = merged[merged.length - 1];
    if (last && last.channel === channel) last.text += ' ' + text;
    else merged.push({ channel, text });
  }
  return merged;
}

/** "Them: ...\nYou: ..." with same-speaker fragments joined. */
function formatTurns(turns) {
  return mergeSpeakerTurns(turns)
    .map((turn) => `${speakerLabel(turn.channel)}: ${turn.text}`)
    .join('\n');
}

function turnChars(turn) {
  return String((turn && turn.text) || '').length + 8; // text + "Them: " + newline
}

/**
 * How many turns fit in `maxChars`, counted from the start (oldest first) or
 * from the end (newest first). Always at least one turn when any exist, so a
 * single long monologue is never skipped. `maxChars` of 0 means no limit.
 */
function countTurnsWithinBudget(turns, maxChars, { fromEnd = false } = {}) {
  const list = turns || [];
  if (!maxChars || maxChars <= 0) return list.length;
  let used = 0;
  let count = 0;
  for (let step = 0; step < list.length; step++) {
    const turn = fromEnd ? list[list.length - 1 - step] : list[step];
    const size = turnChars(turn);
    if (count > 0 && used + size > maxChars) break;
    used += size;
    count += 1;
  }
  return count;
}

// The conversation as it stood at a past moment: every turn up to and
// including the one stamped `ts`. Used when the user asks about an earlier
// line from the history, so the answer is built from what had been said by
// then rather than from whatever is being said now. Without a usable `ts`
// the whole transcript is returned unchanged.
function transcriptThrough(transcript, ts) {
  const turns = Array.isArray(transcript) ? transcript : [];
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return turns;
  let end = turns.length;
  while (end > 0 && !(turns[end - 1] && turns[end - 1].ts <= ts)) end -= 1;
  return end === turns.length ? turns : turns.slice(0, end);
}

module.exports = { speakerLabel, mergeSpeakerTurns, formatTurns, countTurnsWithinBudget, transcriptThrough };
