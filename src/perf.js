// Opt-in timing for cue's hot paths. Start cue with CUE_PERF=1 to print one
// line per answer, notes update and transcribed utterance, e.g.
//
//   [perf] qna mode=ask provider=gemini screenshot=0ms request_sent=4ms first_token=612ms done=1894ms prompt_tokens=3310 cached_tokens=2816
//
// With the variable unset every call here is a no-op, so the traces can stay in
// the code permanently and cost nothing in normal use.

function perfEnabled(env = process.env) {
  const value = env && env.CUE_PERF;
  return !!value && value !== '0' && value !== 'false';
}

const NOOP_TRACE = Object.freeze({
  enabled: false,
  mark() {},
  markOnce() {},
  set() {},
  end() {}
});

function formatValue(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(1);
  return String(value).replace(/\s+/g, '_');
}

/**
 * Start a trace. `mark(name)` records milliseconds since the trace began,
 * `set(key, value)` attaches a fact (token counts, sizes), and `end()` prints
 * the line. Marks are printed in the order they happened.
 */
function createTrace(kind, fields = {}, { log = console.log, now = () => performance.now(), env = process.env } = {}) {
  if (!perfEnabled(env)) return NOOP_TRACE;
  const startedAt = now();
  const marks = [];
  const seen = new Set();
  const facts = { ...fields };
  let ended = false;

  return {
    enabled: true,
    mark(name) {
      marks.push([name, Math.round(now() - startedAt)]);
      seen.add(name);
    },
    markOnce(name) {
      if (!seen.has(name)) this.mark(name);
    },
    set(key, value) {
      if (value !== undefined && value !== null && value !== '') facts[key] = value;
    },
    end(status = 'ok') {
      if (ended) return;
      ended = true;
      const parts = [];
      for (const [key, value] of Object.entries(fields)) {
        if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${formatValue(value)}`);
      }
      for (const [name, ms] of marks) parts.push(`${name}=${ms}ms`);
      for (const [key, value] of Object.entries(facts)) {
        if (key in fields) continue;
        parts.push(`${key}=${formatValue(value)}`);
      }
      parts.push(`total=${Math.round(now() - startedAt)}ms`);
      if (status !== 'ok') parts.push(`status=${formatValue(status)}`);
      log(`[perf] ${kind} ${parts.join(' ')}`);
    }
  };
}

/** Print a single line of facts with no timeline (e.g. one transcribed utterance). */
function logPerf(kind, facts = {}, { log = console.log, env = process.env } = {}) {
  if (!perfEnabled(env)) return;
  const parts = [];
  for (const [key, value] of Object.entries(facts)) {
    if (value !== undefined && value !== null && value !== '') parts.push(`${key}=${formatValue(value)}`);
  }
  log(`[perf] ${kind} ${parts.join(' ')}`);
}

module.exports = { perfEnabled, createTrace, logPerf };
