const test = require('node:test');
const assert = require('node:assert/strict');
const { renderMarkdown } = require('../renderer/markdown');

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


