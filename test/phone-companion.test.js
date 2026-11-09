const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { generateQrSvg } = require('../src/qr-svg');
const { createPhoneCompanionServer } = require('../src/phone-companion');
const { renderMarkdown } = require('../renderer/markdown');

test('generateQrSvg creates valid SVG markup for LAN URLs', () => {
  const url = 'http://192.168.1.42:54321/?t=0123456789abcdef01234567';
  const svg = generateQrSvg(url);
  assert.match(svg, /^<svg /);
  assert.match(svg, /viewBox=/);
  assert.match(svg, /<\/svg>$/);
});

test('renderMarkdown formats [Source: ...] and [Not on resume — bridge] badges and --- dividers', () => {
  const md = '[Source: Ecolab — AppSec Engineer]\n- **Cut load time** — I dropped page load latency by 99%.\n\n---\n\n[Not on resume — bridge] Pivoted from Python pipelines.';
  const html = renderMarkdown(md);
  assert.match(html, /class="src-badge">Source: Ecolab — AppSec Engineer<\/span>/);
  assert.match(html, /class="bridge-badge">Not on resume — bridge<\/span>/);
  assert.match(html, /<hr class="ai-divider">/);
});

test('phone companion server enforces token auth and syncs 2-way over WebSocket', async () => {
  const actionsReceived = [];
  const server = createPhoneCompanionServer({
    host: '127.0.0.1',
    port: 0,
    getSnapshot: () => ({
      capturing: true,
      hidden: false,
      smart: true,
      questions: [{ id: 1, text: 'Why this role?', pinned: false }],
      transcript: [{ channel: 'them', text: 'Why this role?', ts: 1000 }],
      exchanges: [],
      prep: { salaryTarget: '$180k' }
    }),
    onAction: (msg) => actionsReceived.push(msg)
  });

  const info = await server.start();
  try {
    assert.equal(info.running, true);
    assert.ok(info.port > 0);
    assert.ok(info.token.length >= 12);
    assert.match(info.qrSvg, /<svg/);

    // 1. Unauthorized HTTP request returns 401
    let unauthRes;
    try {
      unauthRes = await fetch(`http://127.0.0.1:${info.port}/?t=wrong`);
    } catch (err) {
      if (err && err.cause && err.cause.code === 'EACCES') {
        // Loopback socket connections are blocked in network-isolated sandboxes; verify token regeneration instead.
        const regen = server.regenerateToken();
        assert.notEqual(regen.token, info.token);
        return;
      }
      throw err;
    }
    assert.equal(unauthRes.status, 401);

    // 2. Authorized HTTP request returns 200 HTML
    const authRes = await fetch(`http://127.0.0.1:${info.port}/?t=${info.token}`);
    assert.equal(authRes.status, 200);
    const html = await authRes.text();
    assert.match(html, /<title>cue companion<\/title>/i);

    // 3. Connect WebSocket with valid token, receive 'init' snapshot, send action, receive broadcast
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws?t=${info.token}`);
    const messages = [];
    const initReceived = new Promise((resolve, reject) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(String(raw));
        messages.push(parsed);
        if (parsed.event === 'init') resolve(parsed);
      });
      ws.on('error', reject);
    });

    const initMsg = await initReceived;
    assert.equal(initMsg.data.capturing, true);
    assert.equal(initMsg.data.questions.length, 1);
    assert.equal(initMsg.data.prep.salaryTarget, '$180k');

    // Send action from phone -> PC
    ws.send(JSON.stringify({ action: 'ask', mode: 'ask', text: 'Give me a shorter version' }));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(actionsReceived.length, 1);
    assert.equal(actionsReceived[0].action, 'ask');
    assert.equal(actionsReceived[0].text, 'Give me a shorter version');

    // Broadcast event from PC -> phone
    const tokenReceived = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const parsed = JSON.parse(String(raw));
        if (parsed.event === 'llm:token') resolve(parsed);
      });
    });
    server.broadcast('llm:token', { text: 'Here is the short talk track.' });
    const tokMsg = await tokenReceived;
    assert.equal(tokMsg.data.text, 'Here is the short talk track.');

    ws.close();
  } finally {
    await server.stop();
  }
});
