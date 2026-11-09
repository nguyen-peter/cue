// Minimal markdown for cue's AI answers: fenced code (even mid-line), lists
// (ordered & unordered), headings, horizontal dividers, inline code, and formatting.

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function inline(s) {
  return esc(s)
    .replace(/\[Source:\s*([^\]]+)\]/gi, '<span class="src-badge">Source: $1</span>')
    .replace(/\[Not on resume\s*[—–-]\s*bridge\]/gi, '<span class="bridge-badge">Not on resume — bridge</span>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(?<![*\w])\*([^*]+)\*(?![*\w])/g, '<em>$1</em>');
}

// Headings that must never sit inside a solution fence if the model forgot ```.
const CODE_LEAK_RE = /^\s*(?:\(([4-9]|[1-9]\d)\)\s|Time\s+complexity\b|Space\s+complexity\b|Improvements\b)/i;

// Expand lists and dividers the model glued onto one line into separate lines.
function splitGluedLine(raw) {
  // Split badge tags from inline bullets or text on the same line:
  // "[Source: Role] • **Point**" -> "[Source: Role]\n• **Point**"
  let l = raw.replace(/(\[(?:Source:[^\]]+|Not on resume[^\]]+)\])\s+(?=[-*+•‣◦▪▸]|\d+[.)]|\*\*)/gi, '$1\n');
  // Split heading from inline list: "### Title: 1. Item" or "### Title: - Item"
  l = l.replace(/^(#{1,6}\s+[^:]+:?)\s+(?=(?:\d+[.)]|[-*+•‣◦▪▸])\s+)/, '$1\n');
  // Split inline Unicode bullets glued on the same line: "...text • Next bullet"
  l = l.replace(/\s+(?=[•‣◦▪▸]\s+)/g, '\n');
  // Split inline markdown bullets glued after sentence punctuation: "...sentence. - **Next**"
  l = l.replace(/([:;.!?])\s+(?=[-*+]\s+\*\*)/g, '$1\n');
  // Split inline numbered items: "...sentence. 2. Next item" -> "...sentence.\n2. Next item"
  l = l.replace(/([:;.!?])\s+(?=\d+[.)]\s+[A-Z*])/g, '$1\n');
  // Split inline horizontal rule: "...sentence. --- Next"
  l = l.replace(/\s+---\s+/g, '\n---\n');
  return l.split('\n');
}

/**
 * Render `text` and also report the last point up to which the output is
 * settled. Returns { html, stableOffset, stableHtmlLength }:
 *
 *   stableOffset     — characters of `text` ending just after the last blank
 *                      line that sits outside any code fence (0 if none).
 *   stableHtmlLength — length of the HTML produced for that part.
 *
 * A blank line outside a fence closes every open paragraph and list, so the
 * renderer is back in its starting state there. Text appended later can only
 * change the HTML after `stableHtmlLength`, and
 *
 *   renderMarkdown(text) === renderMarkdown(text.slice(0, stableOffset))
 *                          + renderMarkdown(text.slice(stableOffset))
 *
 * which is what lets a streaming answer keep its finished blocks in the page
 * and re-render only the block still being written.
 */
function renderMarkdownParts(text) {
  const source = String(text || '');
  let inCodeBlock = false; // line-splitting's view of "inside a fence"
  let stableOffset = 0;
  let stableHtmlLength = 0;

  let html = '';
  let inCode = false;
  let listType = null; // 'ul' | 'ol' | null
  let buf = [];

  const flushP = () => {
    if (buf.length) {
      html += '<p>' + buf.map(inline).join('<br>') + '</p>';
      buf = [];
    }
  };

  const closeList = () => {
    if (listType === 'ul') {
      html += '</ul>';
      listType = null;
    } else if (listType === 'ol') {
      html += '</ol>';
      listType = null;
    }
  };

  const openCode = (lang) => {
    flushP();
    closeList();
    const safeLang = String(lang || '').replace(/[^a-zA-Z0-9_+-]/g, '');
    const cls = safeLang ? ' class="language-' + safeLang + '"' : '';
    html += '<pre><code' + cls + '>';
    inCode = true;
  };

  const closeCode = () => {
    html += '</code></pre>';
    inCode = false;
  };

  function emitMarkdownLine(line) {
    const trimmed = line.trim();

    // 1. Horizontal divider: ---, ***, ___
    if (/^(?:---|___|\*\*\*)\s*$/.test(trimmed)) {
      flushP();
      closeList();
      html += '<hr class="ai-divider">';
      return;
    }

    // 2. Headings: #, ##, ###, ####, #####, ######
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      flushP();
      closeList();
      const level = headingMatch[1].length;
      html += `<h${level}>` + inline(headingMatch[2]) + `</h${level}>`;
      return;
    }

    // 3. Unordered list: - item, * item, + item, or • / ‣ / ◦ / ▪ / ▸ item
    const ulMatch = /^\s*[-*+•‣◦▪▸]\s+(.+)$/.exec(line);
    if (ulMatch) {
      flushP();
      if (listType !== 'ul') {
        closeList();
        html += '<ul>';
        listType = 'ul';
      }
      html += '<li>' + inline(ulMatch[1]) + '</li>';
      return;
    }

    // 4. Ordered list: 1. item or 1) item
    const olMatch = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (olMatch) {
      flushP();
      if (listType !== 'ol') {
        closeList();
        html += '<ol>';
        listType = 'ol';
      }
      html += '<li>' + inline(olMatch[1]) + '</li>';
      return;
    }

    // 5. Blank line
    if (trimmed === '') {
      flushP();
      closeList();
      return;
    }

    // 6. Regular prose line
    closeList();
    if (/^\s*\(\d+\)\s/.test(line)) flushP();
    buf.push(trimmed);
  }

  function processLine(line) {
    if (inCode) {
      const idx = line.indexOf('```');
      if (idx !== -1) {
        const before = line.slice(0, idx);
        if (before) html += esc(before) + '\n';
        closeCode();
        const after = line.slice(idx + 3).replace(/^\s+/, '');
        if (after) processLine(after);
        return;
      }
      if (CODE_LEAK_RE.test(line)) {
        closeCode();
        processLine(line);
        return;
      }
      html += esc(line) + '\n';
      return;
    }

    const idx = line.indexOf('```');
    if (idx === -1) {
      emitMarkdownLine(line);
      return;
    }
    const before = line.slice(0, idx).replace(/\s+$/, '');
    if (before) emitMarkdownLine(before);
    const rest = line.slice(idx + 3);
    const langMatch = /^([A-Za-z][\w+-]*)/.exec(rest);
    const lang = langMatch ? langMatch[1] : '';
    const after = (lang ? rest.slice(lang.length) : rest).replace(/^\s/, '');
    openCode(lang);
    if (after) processLine(after);
  }

  const lineBreak = /\r?\n/g;
  let lineStart = 0;
  for (;;) {
    const found = lineBreak.exec(source);
    const raw = source.slice(lineStart, found ? found.index : source.length);

    if (raw.includes('```')) inCodeBlock = !inCodeBlock;
    if (inCodeBlock) processLine(raw);
    else for (const line of splitGluedLine(raw)) processLine(line);

    if (!found) break;
    lineStart = found.index + found[0].length;
    // Only a line that has ended (its newline has arrived) can be a boundary:
    // an empty tail is just text that has not been written yet.
    if (raw.trim() === '' && !inCode && !inCodeBlock) {
      stableOffset = lineStart;
      stableHtmlLength = html.length;
    }
  }
  flushP();
  closeList();
  if (inCode) closeCode();
  return { html, stableOffset, stableHtmlLength };
}

function renderMarkdown(text) {
  return renderMarkdownParts(text).html;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { renderMarkdown, renderMarkdownParts, esc };
}
if (typeof window !== 'undefined') {
  window.renderMarkdown = renderMarkdown;
  window.renderMarkdownParts = renderMarkdownParts;
}
