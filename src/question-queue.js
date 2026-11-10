// Question queue policy — the 4-slot strip above the chat, holding both
// auto-detected interviewer questions and questions the user pre-typed.
//
// The one rule that matters: a question the user typed (pinned) is a promise,
// so a background detection may NEVER evict it. Eviction order when full:
//   • detected add  -> evict the oldest detected item; if every slot is
//                      pinned, the detection is dropped (user's list wins)
//   • pinned add    -> evict the oldest detected item; if every slot is
//                      pinned, evict the oldest pinned one (newest wins)
// Duplicates (same normalized text) are ignored regardless of origin.

function createQuestionQueue({ max = 4, normalize = (s) => String(s || '').trim().toLowerCase() } = {}) {
  const items = []; // { id, text, norm, pinned }
  let nextId = 1;

  function has(norm) {
    return items.some((q) => q.norm === norm);
  }

  function evictFor(pinnedAdd) {
    if (items.length < max) return true;
    const idx = items.findIndex((q) => !q.pinned); // oldest detected first
    if (idx !== -1) {
      items.splice(idx, 1);
      return true;
    }
    if (!pinnedAdd) return false; // all pinned: drop the detection
    items.shift(); // all pinned: the user's newest question wins
    return true;
  }

  // `category` is an optional label (behavioral, technical, …) shown next to
  // the question; the queue only carries it.
  function add(text, pinned, category) {
    const clean = String(text || '').trim();
    if (!clean) return false;
    const norm = normalize(clean);
    if (!norm || has(norm)) return false;
    if (!evictFor(pinned)) return false;
    const item = { id: nextId++, text: clean, norm, pinned: !!pinned };
    if (category) item.category = category;
    items.push(item);
    return true;
  }

  return {
    addDetected(text, category) { return add(text, false, category); },
    addPinned(text, category) { return add(text, true, category); },
    // A detected question grew ("…? And how did you…?"): update it where it
    // sits, keeping its id and slot so its hotkey does not move. False when
    // the original is no longer queued (answered or dismissed) or was typed
    // by the user — the caller then decides what to add instead.
    replaceDetected(oldText, newText, category) {
      const oldNorm = normalize(String(oldText || '').trim());
      const clean = String(newText || '').trim();
      const norm = normalize(clean);
      const item = items.find((q) => !q.pinned && q.norm === oldNorm);
      if (!item || !norm) return false;
      if (norm !== oldNorm && has(norm)) return false;
      item.text = clean;
      item.norm = norm;
      if (category) item.category = category; else delete item.category;
      return true;
    },
    // Remove and return the item in slot `index` (0-based), or null.
    takeAt(index) {
      if (index < 0 || index >= items.length) return null;
      return items.splice(index, 1)[0];
    },
    indexOf(id) { return items.findIndex((q) => q.id === id); },
    removeById(id) {
      const idx = items.findIndex((q) => q.id === id);
      if (idx === -1) return false;
      items.splice(idx, 1);
      return true;
    },
    clear() {
      const had = items.length > 0;
      items.length = 0;
      return had;
    },
    size() { return items.length; },
    items() {
      return items.map((q) => (q.category
        ? { id: q.id, text: q.text, pinned: q.pinned, category: q.category }
        : { id: q.id, text: q.text, pinned: q.pinned }));
    }
  };
}

module.exports = { createQuestionQueue };
