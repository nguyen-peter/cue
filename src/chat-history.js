// chat-history.js — bounded, short-lived memory of recent Q&A exchanges so
// typed follow-ups ("explain that more simply", "why did you pick that
// approach?") can reference earlier answers.
//
// Deliberately small and text-only to protect response speed and accuracy:
//   • capped exchanges and truncated answers keep the extra prompt tokens to
//     tens of milliseconds of prefill, never a felt delay;
//   • past screenshots are never resent — every ask recaptures the live screen;
//   • entries expire after a TTL so a long-gone screen can't mislead a fresh
//     question half an hour later.
//
// Pure logic (no Electron), unit-tested like the other src/ modules. Turns are
// always recorded as strict user→assistant pairs sharing one timestamp, so the
// output always alternates correctly (Anthropic rejects non-alternating turns).

const DEFAULTS = {
  maxExchanges: 3,          // user+assistant pairs kept for fast rolling context
  maxSessionExchanges: 50,  // user+assistant pairs kept for full-session memory / synthesis
  ttlMs: 10 * 60 * 1000,    // forget exchanges older than 10 minutes for fast rolling context
  maxAnswerChars: 2000,     // enough to keep an answer's substance + short code
  maxQuestionChars: 500
};

function createChatHistory(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const entries = []; // { role: 'user'|'assistant', text, ts } — rolling window
  const session = []; // { role: 'user'|'assistant', text, ts } — entire session

  return {
    // Record one completed exchange. Empty/failed answers are not recorded so
    // an errored request can never pollute a later follow-up.
    record(userText, assistantText, ts = Date.now()) {
      const answer = String(assistantText || '').trim();
      if (!answer) return;
      const question = String(userText || '').trim().slice(0, cfg.maxQuestionChars) || '(no prompt)';
      const clipped = answer.length > cfg.maxAnswerChars
        ? answer.slice(0, cfg.maxAnswerChars).trimEnd() + ' …[answer truncated]'
        : answer;
      entries.push({ role: 'user', text: question, ts });
      entries.push({ role: 'assistant', text: clipped, ts });
      while (entries.length > cfg.maxExchanges * 2) entries.splice(0, 2);

      session.push({ role: 'user', text: question, ts });
      session.push({ role: 'assistant', text: clipped, ts });
      const maxSession = (cfg.maxSessionExchanges || 50) * 2;
      while (session.length > maxSession) session.splice(0, 2);
    },

    // Recent, unexpired turns ready to prepend to an LLM request.
    recent(now = Date.now()) {
      const cutoff = now - cfg.ttlMs;
      return entries.filter((t) => t.ts >= cutoff).map(({ role, text }) => ({ role, text }));
    },

    // All turns recorded in this session (no TTL cutoff), used for synthesis or full-case recall.
    all() {
      return session.map(({ role, text }) => ({ role, text }));
    },

    clear() {
      entries.length = 0;
      session.length = 0;
    },

    size() { return entries.length / 2; },

    sessionSize() { return session.length / 2; }
  };
}

module.exports = { createChatHistory };
