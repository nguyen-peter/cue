// leetcode-context.js — LeetCode follow-ups.
//
// A LeetCode solve is stateless by design (prompts.js: the mode ignores
// personal context and prior turns), so "make that faster" or "why did you
// pick that approach?" used to start from zero. The chat history does keep
// the answer, but clipped to 2,000 chars — often mid-function — and with no
// marker that it is the code to iterate on.
//
// This keeps the last solve intact (problem + full code block, bounded) and,
// when a later ask is phrased as a follow-up to that solve, returns a
// clearly labelled block for main.js to append to the question. The model
// then answers about THIS solution instead of guessing which code is meant.
//
// Pure logic (no Electron), unit-tested like the other src/ modules.

const DEFAULTS = {
  maxChars: 6000,           // code + answer kept per solve; a solve is one screenful
  maxProblemChars: 500,     // restatement kept as the problem label
  ttlMs: 30 * 60 * 1000     // a coding round runs longer than chat history's 10-min TTL
};

// Starts of a follow-up about the previous solution. "Fix that" and
// "explain that approach" qualify; a fresh question ("What is a hash map?")
// does not, and must not drag the old code into its prompt.
const FOLLOWUP_PATTERNS = [
  /^(fix|debug|optimise|optimize|improve|refactor|make (it|that)|explain|walk (me )?through|why (did|does|is)|what (does|do|is) (that|this|it|the)|how (does|do) (that|this|it|the)|run|test|try)\b/i,
  /\b(that|this|it) (solution|code|function|approach|algorithm|implementation)\b/i,
  /\b(that|this|it)\b.{0,40}\b(solution|code|function|approach|algorithm|bug|faster|complexity|edge cases?)\b/i,
  /\b(the) (solution|code|function|approach|algorithm)\b.{0,40}\b(that|this|it)\b/i
];

function extractCode(answer) {
  const m = /```(?:\w+)?\n([\s\S]*?)```/.exec(String(answer || ''));
  return m ? m[1].trim() : '';
}

function isLeetcodeFollowup(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  return FOLLOWUP_PATTERNS.some((re) => re.test(trimmed));
}

function createLeetcodeContext(options = {}) {
  const cfg = { ...DEFAULTS, ...options };
  let last = null; // { problem, code, answer, ts }

  return {
    // Store a completed solve. problemText is the label main.js passes; when
    // it is empty (LeetCode mode has no typed problem text) the solve's own
    // one-line restatement, its first line, doubles as the problem. The code
    // block is pulled out of the answer so follow-ups get the code, not prose.
    record(problemText, answerText, ts = Date.now()) {
      const answer = String(answerText || '').trim();
      if (!answer) return;
      const code = extractCode(answer);
      const derived = answer.split('\n').map((l) => l.trim()).find(Boolean) || '';
      const problem = String(problemText || '').trim()
        || derived.replace(/^\(1\)\s*/, '').replace(/^#+\s*/, '');
      last = {
        problem: problem.slice(0, cfg.maxProblemChars),
        code: code.slice(0, cfg.maxChars),
        answer: answer.slice(0, cfg.maxChars),
        ts
      };
    },

    // The block to append to a follow-up question, or null when there is no
    // solve, it expired, or the question is not about the solve.
    followupBlock(userText, now = Date.now()) {
      if (!last) return null;
      if (now - last.ts > cfg.ttlMs) return null;
      if (!isLeetcodeFollowup(userText)) return null;
      const agoMin = Math.max(1, Math.round((now - last.ts) / 60000));
      const lines = [
        '=== Previous coding solution (from LeetCode mode, ' + agoMin + ' min ago) ==='
      ];
      if (last.problem) lines.push('Problem: ' + last.problem);
      if (last.code) {
        lines.push('```');
        lines.push(last.code);
        lines.push('```');
      } else {
        lines.push(last.answer);
      }
      lines.push('Answer the follow-up about THIS solution. If the question is about something else on screen, ignore this block.');
      return lines.join('\n');
    },

    has(now = Date.now()) {
      return !!last && (now - last.ts) <= cfg.ttlMs;
    },

    clear() {
      last = null;
    }
  };
}

module.exports = { createLeetcodeContext, isLeetcodeFollowup, extractCode };
