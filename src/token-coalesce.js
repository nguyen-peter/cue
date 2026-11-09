// Batches streaming LLM deltas into ~one IPC/DOM update per animation frame.
// Providers (especially official OpenAI) emit 1–3 character chunks; forwarding
// each as its own ipc+span makes the overlay hitch and feels slower, not faster.

function createTokenCoalescer(onFlush, intervalMs = 16) {
  let buf = '';
  let timer = null;

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buf) return;
    const chunk = buf;
    buf = '';
    onFlush(chunk);
  }

  return {
    push(text) {
      if (!text) return;
      buf += text;
      if (!timer) timer = setTimeout(flush, intervalMs);
    },
    flush
  };
}

module.exports = { createTokenCoalescer };
