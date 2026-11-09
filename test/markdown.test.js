const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown, renderMarkdownParts } = require('../renderer/markdown');

test('a mid-line ```lang opener still becomes a <pre> code block', () => {
  const html = renderMarkdown('(3) ```cpp\nint x = 1;\n```\n(4) Time complexity: fast.');
  assert.match(html, /<p>\(3\)<\/p>/);
  assert.match(html, /<pre><code class="language-cpp">/);
  assert.match(html, /int x = 1;/);
  assert.match(html, /<p>\(4\) Time complexity: fast\.<\/p>/);
  assert.ok(!html.includes('(4) Time complexity: fast.</code>'), 'section 4 must not live inside the code block');
});

test('code glued onto the opening fence is still code, not a paragraph', () => {
  const html = renderMarkdown('(3) ```cpp class Solution {\n  int n = 0;\n};\n```\n(4) done');
  assert.match(html, /<pre><code class="language-cpp">/);
  assert.match(html, /class Solution \{/);
  assert.doesNotMatch(html, /<p>\(3\) ```cpp/);
  assert.match(html, /<p>\(4\) done<\/p>/);
});

test('a missing closing fence does not swallow Time complexity / (4) into the code block', () => {
  const html = renderMarkdown('(3) ```cpp\nint n = 1;\n\n(4) Time complexity: `O(n)`.\n(5) Improvements:\n- use a map');
  const pre = html.match(/<pre>[\s\S]*?<\/pre>/)[0];
  assert.ok(pre.includes('int n = 1;'));
  assert.ok(!pre.includes('Time complexity'));
  assert.match(html, /<p>\(4\) Time complexity: <code>O\(n\)<\/code>\.<\/p>/);
  assert.match(html, /<p>\(5\) Improvements:<\/p>/);
  assert.match(html, /<ul><li>use a map<\/li><\/ul>/);
});

test('inline backticks in prose stay inline and do not start a fence', () => {
  const html = renderMarkdown('Time complexity: `O(n^2)`, because we check pairs.');
  assert.match(html, /<code>O\(n\^2\)<\/code>/);
  assert.ok(!html.includes('<pre>'));
});

test('a proper standalone fence still works', () => {
  const html = renderMarkdown('see:\n```python\nprint(1)\n```\nok');
  assert.match(html, /<pre><code class="language-python">print\(1\)\n<\/code><\/pre>/);
  assert.match(html, /<p>ok<\/p>/);
});

test('the palindrome-cut shape from a real Ctrl+H answer: opener glued to (3), no closer, (4)/(5) as prose', () => {
  const raw =
    '(1) Find the fewest places to cut a string so every piece is a palindrome.\n\n' +
    '(2) We first figure out which parts are palindromes.\n\n' +
    '(3) ```cpp class Solution { public:\n' +
    'int minCut(string s) {\n' +
    'int n = (int)s.size();\n' +
    'return cuts[n - 1]; } };\n\n\n' +
    '(4) Time complexity: `O(n^2)`, because we check every start/end pair once.\n' +
    'Space complexity: `O(n^2)`, because we store a table.\n\n' +
    '(5) Improvements / alternatives:\n' +
    '- Use center expansion instead of a full palindrome table.';
  const html = renderMarkdown(raw);
  const pre = html.match(/<pre>[\s\S]*?<\/pre>/)[0];
  assert.match(pre, /minCut/);
  assert.ok(!pre.includes('Time complexity'));
  assert.ok(!pre.includes('Improvements'));
  assert.match(html, /<p>\(4\) Time complexity: <code>O\(n\^2\)<\/code>/);
  assert.match(html, /<li>Use center expansion/);
  assert.ok(!/<p>\(3\) ```cpp/.test(html));
});

test('escapes HTML inside code', () => {
  const html = renderMarkdown('```\n<script>x</script>\n```');
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.ok(!html.includes('<script>x</script>'));
});

test('renders markdown headings, dividers, and ordered lists', () => {
  const input = '### Recommended Target Range: $85k - $105k\n\n---\n\n### How to Justify It:\n1. First point\n2. Second point';
  const html = renderMarkdown(input);
  assert.match(html, /<h3>Recommended Target Range: \$85k - \$105k<\/h3>/);
  assert.match(html, /<hr class="ai-divider">/);
  assert.match(html, /<h3>How to Justify It:<\/h3>/);
  assert.match(html, /<ol><li>First point<\/li><li>Second point<\/li><\/ol>/);
});

test('splits and formats glued inline numbered lists gracefully', () => {
  const glued = '### Justification: 1. Versatility across stacks. 2. High demand skills.';
  const html = renderMarkdown(glued);
  assert.match(html, /<h3>Justification:<\/h3>/);
  assert.match(html, /<ol><li>Versatility across stacks\.<\/li><li>High demand skills\.<\/li><\/ol>/);
});

test('renders Unicode bullet points (•) and inline glued bullets as <ul><li> lists instead of a single paragraph', () => {
  const unicodeBullets = '[Source: Ecolab — AppSec Engineer] • **First point** — I built the scanner. • **Second point** — We cut latency by 99%.';
  const html = renderMarkdown(unicodeBullets);
  assert.match(html, /<p><span class="src-badge">Source: Ecolab — AppSec Engineer<\/span><\/p>/);
  assert.match(html, /<ul><li><strong>First point<\/strong> — I built the scanner\.<\/li><li><strong>Second point<\/strong> — We cut latency by 99%\.<\/li><\/ul>/);
});

// ── Streaming: finished blocks are rendered once ────────────────────────────
// While an answer streams in, the renderer keeps the HTML for everything up to
// the last settled point and re-renders only the block still being written.
// That is only safe if it produces exactly what a full render would.

const STREAM_SAMPLES = {
  'talk track with divider': '[Source: Ecolab — AppSec Engineer]\n- **Cut load time** — I dropped latency by 99%.\n- **Owned rollout** — we shipped in two weeks.\n\n---\n\nDeeper detail: we used `EF Core` projections.\n\n1. First step\n2. Second step\n\nDone.',
  'fenced code with blank lines inside': '(1) Restate the problem.\n\n(2) Approach in plain words.\n\n(3)\n```python\ndef f(xs):\n\n    seen = set()\n\n    return seen\n```\n\n(4) Time complexity: `O(n)`.\n\n(5) Improvements:\n- use a map\n- handle empty input',
  'unclosed fence then prose sections': '(3) ```cpp class Solution { public:\nint minCut(string s) {\n\nreturn 0; } };\n\n\n(4) Time complexity: `O(n^2)`.\nSpace complexity: `O(n)`.\n\n(5) Improvements / alternatives:\n- Use center expansion.',
  'glued bullets and numbered items': '### Justification: 1. Versatility across stacks. 2. High demand skills.\n\nIntro text • **First** — one. • **Second** — two.\n\nClosing line.',
  'windows line endings': 'First paragraph.\r\n\r\n- item one\r\n- item two\r\n\r\nLast paragraph.',
  'two fences on one line': 'Use ```js let a = 1;``` inline.\n\nNext paragraph.\n\n```\nplain\n```\n\nEnd.',
  'whitespace-only separator lines': 'Para one.\n   \nPara two.\n\t\n- a\n- b\n  \nPara three.'
};

// Shapes where the fence state never returns to "closed" (an opener with no
// closer, or two fences on one line). Nothing is frozen for these, so they are
// simply re-rendered in full each time, exactly as before.
const NEVER_SETTLES = new Set(['unclosed fence then prose sections', 'two fences on one line']);

for (const [name, sample] of Object.entries(STREAM_SAMPLES)) {
  test(`streaming render equals a full render at every length: ${name}`, () => {
    let frozenChars = 0;
    let frozenHtml = '';
    for (let length = 1; length <= sample.length; length++) {
      const raw = sample.slice(0, length);

      // The split point reported for the whole text is a true split point.
      const whole = renderMarkdownParts(raw);
      assert.equal(whole.html, renderMarkdown(raw));
      assert.equal(
        renderMarkdown(raw.slice(0, whole.stableOffset)) + renderMarkdown(raw.slice(whole.stableOffset)),
        whole.html,
        `split at ${whole.stableOffset} changes the output at length ${length}`
      );

      // What the renderer actually does: render only the part not yet frozen.
      const pending = renderMarkdownParts(raw.slice(frozenChars));
      frozenHtml += pending.html.slice(0, pending.stableHtmlLength);
      frozenChars += pending.stableOffset;
      const shown = frozenHtml + pending.html.slice(pending.stableHtmlLength);
      assert.equal(shown, whole.html, `incremental output diverged at length ${length}`);
    }
    if (NEVER_SETTLES.has(name)) assert.equal(frozenChars, 0);
    else assert.ok(frozenChars > 0, 'the sample should freeze at least one block');
  });
}

test('nothing is frozen inside an open code fence or before a line has ended', () => {
  assert.equal(renderMarkdownParts('```js\nlet a = 1;\n\nlet b = 2;\n').stableOffset, 0);
  assert.equal(renderMarkdownParts('One paragraph').stableOffset, 0);
  assert.equal(renderMarkdownParts('One paragraph\n').stableOffset, 0);
  assert.equal(renderMarkdownParts('One paragraph\n\n').stableOffset, 15);
  assert.equal(renderMarkdownParts('').stableOffset, 0);
});


