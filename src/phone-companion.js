const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { generateQrSvg } = require('./qr-svg');

function getLanAddresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, list] of Object.entries(interfaces || {})) {
    for (const info of list || []) {
      const family = info.family === 4 || info.family === 'IPv4';
      if (!family || info.internal || !info.address) continue;
      if (info.address.startsWith('169.254.')) continue;
      const isVirtual = /vethernet|wsl|hyper-v|docker|vbox|vmware|loopback|tailscale|tun|tap/i.test(name);
      candidates.push({
        name,
        address: info.address,
        priority: isVirtual ? 2 : (info.address.startsWith('192.168.') || info.address.startsWith('10.') ? 0 : 1)
      });
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map((c) => c.address);
}

function buildPhoneHtml(token) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>cue companion</title>
  <style>
    :root {
      --bg: #0b0d13;
      --card: #141822;
      --card-hi: #1c2230;
      --border: rgba(255,255,255,0.10);
      --text: #f1f5f9;
      --muted: #94a3b8;
      --accent: #60a5fa;
      --green: #34d399;
      --amber: #fbbf24;
      --red: #f87171;
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
    html, body {
      margin: 0; padding: 0; height: 100%; width: 100%;
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      overflow: hidden;
    }
    #app {
      display: flex; flex-direction: column; height: 100dvh;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom);
    }
    /* Top Header */
    .topbar {
      display: flex; align-items: center; gap: 8px;
      padding: 10px 12px; background: var(--card);
      border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .dot {
      width: 9px; height: 9px; border-radius: 50%; background: #475569; flex-shrink: 0;
    }
    .dot.idle { background: var(--green); box-shadow: 0 0 8px var(--green); }
    .dot.speaking, .dot.transcribing { background: var(--amber); box-shadow: 0 0 10px var(--amber); }
    .brand { font-weight: 700; font-size: 15px; letter-spacing: -0.3px; margin-right: auto; display: flex; align-items: center; gap: 6px; }
    .conn-pill { font-size: 11px; color: var(--muted); font-weight: 500; }
    .tb-btn {
      background: var(--card-hi); color: var(--text);
      border: 1px solid var(--border); border-radius: 999px;
      padding: 6px 11px; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    .tb-btn.active { background: rgba(52,211,153,0.18); border-color: var(--green); color: var(--green); }
    .tb-btn.warn { background: rgba(251,191,36,0.16); border-color: var(--amber); color: var(--amber); }

    /* Navigation Tabs */
    .tabs {
      display: flex; background: var(--card); border-bottom: 1px solid var(--border); flex-shrink: 0;
    }
    .tab {
      flex: 1; text-align: center; padding: 10px 4px; font-size: 13px; font-weight: 600;
      color: var(--muted); border-bottom: 2px solid transparent; cursor: pointer;
    }
    .tab.on { color: var(--text); border-bottom-color: var(--accent); }
    .badge {
      display: inline-block; background: var(--accent); color: #090d16;
      border-radius: 999px; padding: 1px 6px; font-size: 10px; font-weight: 700; margin-left: 4px;
    }

    /* Tab Panes */
    .pane { display: none; flex: 1; flex-direction: column; min-height: 0; overflow: hidden; }
    .pane.on { display: flex; }

    /* Question Queue Strip */
    .qq-box {
      background: rgba(96,165,250,0.07); border-bottom: 1px solid var(--border);
      padding: 8px 10px; flex-shrink: 0; max-height: 34vh; overflow-y: auto;
    }
    .qq-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .qq-row {
      display: flex; align-items: center; gap: 8px; background: var(--card);
      border: 1px solid var(--border); border-radius: 8px; padding: 7px 9px; margin-bottom: 5px;
      cursor: pointer;
    }
    .qq-row:active { background: var(--card-hi); }
    .qq-num {
      background: rgba(96,165,250,0.2); color: var(--accent);
      font-size: 11px; font-weight: 700; width: 20px; height: 20px; border-radius: 5px;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .qq-txt { flex: 1; font-size: 13px; line-height: 1.3; }
    .qq-del {
      background: transparent; border: none; color: var(--muted); font-size: 15px; padding: 2px 6px; cursor: pointer;
    }
    .qq-add-row { display: flex; gap: 6px; margin-top: 4px; }
    .qq-input {
      flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 7px; padding: 6px 9px; font-size: 12px; outline: none;
    }
    .qq-add-btn {
      background: var(--card-hi); color: var(--text); border: 1px solid var(--border);
      border-radius: 7px; padding: 6px 10px; font-size: 12px; font-weight: 600;
    }

    /* Scrollable Lists */
    .scroll-area {
      flex: 1; overflow-y: auto; padding: 12px; -webkit-overflow-scrolling: touch;
    }
    .empty-hint { color: var(--muted); font-size: 13px; text-align: center; margin-top: 32px; }

    /* Chat Messages */
    .msg-group {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 12px; padding: 11px 13px; margin-bottom: 10px;
    }
    .msg-meta { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--muted); margin-bottom: 6px; }
    .msg-user {
      background: rgba(96,165,250,0.14); color: #bfdbfe;
      padding: 6px 10px; border-radius: 8px; font-size: 13px; font-weight: 500; margin-bottom: 8px;
    }
    .msg-ai { font-size: 15px; line-height: 1.5; word-wrap: break-word; }
    .msg-ai hr { border: none; border-top: 1px dashed rgba(255,255,255,0.18); margin: 10px 0; }
    .msg-ai ul { margin: 4px 0 8px 0; padding-left: 18px; }
    .msg-ai li { margin-bottom: 6px; }
    .msg-ai code { background: rgba(0,0,0,0.35); padding: 1px 5px; border-radius: 4px; font-size: 13px; }
    .msg-ai pre { background: #07090e; padding: 10px; border-radius: 8px; overflow-x: auto; font-size: 12px; }
    .src-badge {
      display: inline-block; background: rgba(52,211,153,0.15); color: var(--green);
      border: 1px solid rgba(52,211,153,0.35); border-radius: 6px;
      padding: 2px 7px; font-size: 11px; font-weight: 600; margin-bottom: 6px;
    }
    .bridge-badge {
      display: inline-block; background: rgba(251,191,36,0.15); color: var(--amber);
      border: 1px solid rgba(251,191,36,0.35); border-radius: 6px;
      padding: 2px 7px; font-size: 11px; font-weight: 600; margin-bottom: 6px;
    }

    /* Quick Action Chips + Input Bar */
    .quick-bar {
      display: flex; gap: 6px; overflow-x: auto; padding: 7px 10px;
      background: var(--card); border-top: 1px solid var(--border); flex-shrink: 0;
    }
    .quick-bar::-webkit-scrollbar { display: none; }
    .chip {
      background: var(--card-hi); color: var(--text); border: 1px solid var(--border);
      border-radius: 999px; padding: 6px 11px; font-size: 12px; font-weight: 600;
      white-space: nowrap; cursor: pointer; flex-shrink: 0;
    }
    .chip.primary { background: rgba(96,165,250,0.2); border-color: var(--accent); color: #93c5fd; }
    .composer {
      display: flex; gap: 8px; padding: 8px 10px; background: var(--card);
      border-top: 1px solid var(--border); flex-shrink: 0;
    }
    .chat-input {
      flex: 1; background: var(--bg); color: var(--text); border: 1px solid var(--border);
      border-radius: 10px; padding: 9px 12px; font-size: 14px; outline: none;
    }
    .send-btn {
      background: var(--accent); color: #090d16; border: none; border-radius: 10px;
      padding: 0 16px; font-weight: 700; font-size: 14px; cursor: pointer;
    }

    /* Transcript History Turns */
    .ts-row {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 10px; padding: 9px 11px; margin-bottom: 8px;
    }
    .ts-row.them { border-left: 3px solid var(--accent); }
    .ts-row.you { border-left: 3px solid var(--green); opacity: 0.88; }
    .ts-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .ts-who { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; }
    .ts-row.them .ts-who { color: var(--accent); }
    .ts-row.you .ts-who { color: var(--green); }
    .ts-acts { display: flex; gap: 5px; }
    .ts-btn {
      background: var(--card-hi); color: var(--text); border: 1px solid var(--border);
      border-radius: 6px; padding: 3px 8px; font-size: 11px; font-weight: 600; cursor: pointer;
    }
    .ts-body { font-size: 14px; line-height: 1.42; }

    /* Prep Cards */
    .prep-card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 10px; padding: 11px 13px; margin-bottom: 10px;
    }
    .prep-title { font-size: 12px; font-weight: 700; color: var(--accent); text-transform: uppercase; margin-bottom: 6px; }
    .prep-body { font-size: 13px; line-height: 1.45; white-space: pre-wrap; color: var(--text); }
  </style>
</head>
<body>
  <div id="app">
    <div class="topbar">
      <span id="dot" class="dot"></span>
      <div class="brand">cue <span id="conn" class="conn-pill">connecting…</span></div>
      <button id="quick-top-btn" class="tb-btn">⚡ Quick</button>
      <button id="listen-btn" class="tb-btn">Listen</button>
      <button id="hide-pc-btn" class="tb-btn">Hide PC</button>
    </div>

    <div class="tabs">
      <div class="tab on" data-tab="chat">Chat & Queue <span id="q-badge" class="badge" style="display:none">0</span></div>
      <div class="tab" data-tab="history">Transcript</div>
      <div class="tab" data-tab="prep">Prep & Controls</div>
    </div>

    <!-- TAB 1: CHAT & QUEUE -->
    <div id="pane-chat" class="pane on">
      <div class="qq-box">
        <div class="qq-head">
          <span>Question Queue (tap to answer)</span>
        </div>
        <div id="qq-list"></div>
        <div class="qq-add-row">
          <input id="qq-input" class="qq-input" type="text" placeholder="Queue a question…" />
          <button id="qq-add-btn" class="qq-add-btn">+ Queue</button>
        </div>
      </div>

      <div id="chat-list" class="scroll-area">
        <div id="chat-empty" class="empty-hint">Answers stream here and on your PC simultaneously.</div>
      </div>

      <div class="quick-bar">
        <button class="chip primary" data-mode="say">What should I say?</button>
        <button class="chip" data-mode="leetcode">Solve Code</button>
        <button class="chip" data-ask="Update or fix the code for the interviewer's follow-up constraint or the latest error/changes on screen, and give me a 2-bullet spoken explanation of what changed.">Modify / Fix Code</button>
        <button class="chip" data-mode="assist">Assist (PC Screen)</button>
        <button class="chip" data-ask="Make that shorter — 2-3 quick spoken bullets.">Shorter</button>
        <button class="chip" data-ask="Give me a concrete real-world example from my background.">+ Example</button>
        <button class="chip" data-mode="followup">Follow-ups</button>
        <button class="chip" data-mode="recap">Recap</button>
      </div>

      <div class="composer">
        <input id="chat-input" class="chat-input" type="text" placeholder="Ask about the conversation…" />
        <button id="send-btn" class="send-btn">Send</button>
      </div>
    </div>

    <!-- TAB 2: LIVE TRANSCRIPT -->
    <div id="pane-history" class="pane">
      <div id="ts-list" class="scroll-area">
        <div id="ts-empty" class="empty-hint">Live conversation history appears here when listening.</div>
      </div>
    </div>

    <!-- TAB 3: PREP & CONTROLS -->
    <div id="pane-prep" class="pane">
      <div class="scroll-area">
        <div class="prep-card" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
          <button id="smart-btn" class="tb-btn">Tier: Fast</button>
          <button id="quick-btn" class="tb-btn">⚡ Quick: Off</button>
          <button id="clear-btn" class="tb-btn">Clear Session History</button>
        </div>
        <div id="prep-cards"></div>
      </div>
    </div>
  </div>

  <script>
    (function() {
      const TOKEN = ${JSON.stringify(token)};
      const dot = document.getElementById('dot');
      const conn = document.getElementById('conn');
      const listenBtn = document.getElementById('listen-btn');
      const hidePcBtn = document.getElementById('hide-pc-btn');
      const qBadge = document.getElementById('q-badge');
      const qqList = document.getElementById('qq-list');
      const qqInput = document.getElementById('qq-input');
      const qqAddBtn = document.getElementById('qq-add-btn');
      const chatList = document.getElementById('chat-list');
      const chatEmpty = document.getElementById('chat-empty');
      const chatInput = document.getElementById('chat-input');
      const sendBtn = document.getElementById('send-btn');
      const tsList = document.getElementById('ts-list');
      const tsEmpty = document.getElementById('ts-empty');
      const smartBtn = document.getElementById('smart-btn');
      const quickBtn = document.getElementById('quick-btn');
      const quickTopBtn = document.getElementById('quick-top-btn');
      const clearBtn = document.getElementById('clear-btn');
      const prepCards = document.getElementById('prep-cards');

      let ws = null;
      let currentAiEl = null;
      let currentRaw = '';
      let lastTsTurn = { you: null, them: null };
      let lastTsAt = { you: 0, them: 0 };

      function isNearBottom(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 56;
      }

      function escapeHtml(s) {
        return String(s || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      function formatAiHtml(raw) {
        let html = escapeHtml(raw);
        html = html.replace(/\\[Source:\\s*([^\\]]+)\\]/gi, '<span class="src-badge">Source: $1</span>');
        html = html.replace(/\\[Not on resume\\s*[—\\-]\\s*bridge\\]/gi, '<span class="bridge-badge">Not on resume — bridge</span>');
        html = html.replace(/\`\`\`([a-zA-Z0-9_-]*)\\n([\\s\\S]*?)\`\`\`/g, '<pre><code>$2</code></pre>');
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/^---$/gm, '<hr/>');
        html = html.replace(/^[•\\-\\*]\\s+(.+)$/gm, '• $1');
        return html.replace(/\\n/g, '<br/>');
      }

      // Tabs
      document.querySelectorAll('.tab').forEach((tab) => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach((t) => t.classList.remove('on'));
          document.querySelectorAll('.pane').forEach((p) => p.classList.remove('on'));
          tab.classList.add('on');
          document.getElementById('pane-' + tab.dataset.tab).classList.add('on');
        });
      });

      function sendAction(action, payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ action, type: action, ...payload }));
        } else {
          connect();
        }
      }

      listenBtn.addEventListener('click', () => sendAction('capture:toggle', {}));
      hidePcBtn.addEventListener('click', () => sendAction('hide:toggle', {}));
      smartBtn.addEventListener('click', () => sendAction('smart:toggle', {}));
      if (quickBtn) quickBtn.addEventListener('click', () => sendAction('quick:toggle', {}));
      if (quickTopBtn) quickTopBtn.addEventListener('click', () => sendAction('quick:toggle', {}));
      clearBtn.addEventListener('click', () => sendAction('chat:clear', {}));

      function submitQuestionQueue() {
        const text = qqInput.value.trim();
        if (!text) return;
        sendAction('question:add', { text });
        qqInput.value = '';
      }
      qqAddBtn.addEventListener('click', submitQuestionQueue);
      qqInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitQuestionQueue(); });

      function submitChat() {
        const text = chatInput.value.trim();
        if (!text) return;
        sendAction('ask', { mode: 'ask', text });
        chatInput.value = '';
      }
      sendBtn.addEventListener('click', submitChat);
      chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitChat(); });

      document.querySelectorAll('.chip').forEach((chip) => {
        chip.addEventListener('click', () => {
          if (chip.dataset.mode) sendAction('ask', { mode: chip.dataset.mode, text: '' });
          else if (chip.dataset.ask) sendAction('ask', { mode: 'ask', text: chip.dataset.ask });
        });
      });

      function renderQueue(items) {
        qqList.innerHTML = '';
        if (items && items.length) {
          qBadge.style.display = 'inline-block';
          qBadge.textContent = String(items.length);
        } else {
          qBadge.style.display = 'none';
        }
        (items || []).forEach((item, idx) => {
          const row = document.createElement('div');
          row.className = 'qq-row';
          const num = document.createElement('span');
          num.className = 'qq-num';
          num.textContent = String(idx + 1);
          const txt = document.createElement('span');
          txt.className = 'qq-txt';
          txt.textContent = item.text;
          const del = document.createElement('button');
          del.className = 'qq-del';
          del.textContent = '✕';
          del.addEventListener('click', (e) => {
            e.stopPropagation();
            sendAction('question:dismiss', { id: item.id });
          });
          row.appendChild(num);
          row.appendChild(txt);
          row.appendChild(del);
          row.addEventListener('click', () => sendAction('question:answer', { id: item.id }));
          qqList.appendChild(row);
        });
      }

      function startAiMessage(userBubble, category) {
        if (chatEmpty) chatEmpty.style.display = 'none';
        const stick = isNearBottom(chatList);
        const group = document.createElement('div');
        group.className = 'msg-group';
        const meta = document.createElement('div');
        meta.className = 'msg-meta';
        meta.innerHTML = '<span>' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '</span>' +
          (category ? '<span>' + escapeHtml(category.toUpperCase()) + '</span>' : '');
        group.appendChild(meta);
        if (userBubble) {
          const ub = document.createElement('div');
          ub.className = 'msg-user';
          ub.textContent = userBubble;
          group.appendChild(ub);
        }
        const ai = document.createElement('div');
        ai.className = 'msg-ai';
        group.appendChild(ai);
        chatList.appendChild(group);
        currentAiEl = ai;
        currentRaw = '';
        if (stick) chatList.scrollTop = chatList.scrollHeight;
      }

      function appendTranscript(channel, text) {
        if (!text || !text.trim()) return;
        if (tsEmpty) tsEmpty.style.display = 'none';
        const stick = isNearBottom(tsList);
        const now = Date.now();
        const other = channel === 'you' ? 'them' : 'you';
        lastTsTurn[other] = null;

        if (lastTsTurn[channel] && (now - lastTsAt[channel] < 10000)) {
          const body = lastTsTurn[channel].querySelector('.ts-body');
          body.textContent = body.textContent + ' ' + text.trim();
          lastTsTurn[channel].dataset.fullText = body.textContent;
        } else {
          const row = document.createElement('div');
          row.className = 'ts-row ' + channel;
          row.dataset.fullText = text.trim();
          const head = document.createElement('div');
          head.className = 'ts-head';
          const who = document.createElement('span');
          who.className = 'ts-who';
          who.textContent = channel === 'them' ? 'Them' : 'You';
          head.appendChild(who);

          if (channel === 'them') {
            const acts = document.createElement('div');
            acts.className = 'ts-acts';
            const qBtn = document.createElement('button');
            qBtn.className = 'ts-btn';
            qBtn.textContent = '+ Queue';
            qBtn.addEventListener('click', () => sendAction('question:add', { text: row.dataset.fullText }));
            const aBtn = document.createElement('button');
            aBtn.className = 'ts-btn';
            aBtn.textContent = 'Answer';
            aBtn.addEventListener('click', () => sendAction('ask', { mode: 'answerThis', text: row.dataset.fullText }));
            acts.appendChild(qBtn);
            acts.appendChild(aBtn);
            head.appendChild(acts);
          }

          const body = document.createElement('div');
          body.className = 'ts-body';
          body.textContent = text.trim();
          row.appendChild(head);
          row.appendChild(body);
          row.addEventListener('click', (e) => {
            if (e.target.closest('.ts-btn')) return;
            const textToAsk = (row.dataset.fullText || body.textContent || '').trim();
            if (textToAsk) {
              sendAction('ask', { mode: 'ask', text: textToAsk });
              const chatTab = document.querySelector('.tab[data-tab="chat"]');
              if (chatTab) chatTab.click();
            }
          });
          tsList.appendChild(row);
          lastTsTurn[channel] = row;
        }
        lastTsAt[channel] = now;
        if (stick) tsList.scrollTop = tsList.scrollHeight;
      }

      function renderPrep(prep) {
        prepCards.innerHTML = '';
        const sections = [
          ['STAR Stories', prep && prep.starStories],
          ['Why Company / Why Leaving', [prep && prep.whyCompany, prep && prep.whyLeaving].filter(Boolean).join('\\n\\n')],
          ['Salary Target', prep && prep.salaryTarget],
          ['Questions to Ask', prep && prep.questionsToAsk],
          ['Job Description', prep && prep.jobDescription],
          ['Resume', prep && prep.resumeText],
          ['Meeting Doc', prep && prep.contextDoc]
        ];
        sections.forEach(([title, content]) => {
          if (!content || !String(content).trim()) return;
          const card = document.createElement('div');
          card.className = 'prep-card';
          card.innerHTML = '<div class="prep-title">' + escapeHtml(title) + '</div><div class="prep-body">' + escapeHtml(content) + '</div>';
          prepCards.appendChild(card);
        });
      }

      function applyStatus({ capturing, hidden, smart, quick }) {
        if (typeof capturing === 'boolean') {
          listenBtn.textContent = capturing ? 'Listening' : 'Listen';
          listenBtn.classList.toggle('active', capturing);
          dot.className = 'dot ' + (capturing ? 'idle' : '');
        }
        if (typeof hidden === 'boolean') {
          hidePcBtn.textContent = hidden ? 'Show PC' : 'Hide PC';
          hidePcBtn.classList.toggle('warn', hidden);
        }
        if (typeof smart === 'boolean') {
          smartBtn.textContent = 'Tier: ' + (smart ? 'Smart' : 'Fast');
          smartBtn.classList.toggle('active', smart);
        }
        if (typeof quick === 'boolean') {
          if (quickBtn) {
            quickBtn.textContent = '⚡ Quick: ' + (quick ? 'On' : 'Off');
            quickBtn.classList.toggle('warn', quick);
          }
          if (quickTopBtn) {
            quickTopBtn.textContent = quick ? '⚡ Quick ON' : '⚡ Quick';
            quickTopBtn.classList.toggle('warn', quick);
          }
        }
      }

      function connect() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(proto + '//' + location.host + '/ws?t=' + encodeURIComponent(TOKEN));
        ws.onopen = () => { conn.textContent = 'live'; };
        ws.onclose = () => {
          conn.textContent = 'reconnecting…';
          setTimeout(connect, 1500);
        };
        ws.onmessage = (ev) => {
          let msg;
          try { msg = JSON.parse(ev.data); } catch { return; }
          const { event, data } = msg;
          if (event === 'init') {
            applyStatus(data);
            renderQueue(data.questions || []);
            renderPrep(data.prep || {});
            tsList.innerHTML = '';
            lastTsTurn = { you: null, them: null };
            if ((data.transcript || []).length) {
              data.transcript.forEach((t) => appendTranscript(t.channel, t.text));
            } else if (tsEmpty) {
              tsList.appendChild(tsEmpty);
              tsEmpty.style.display = 'block';
            }
            chatList.innerHTML = '';
            if ((data.exchanges || []).length) {
              data.exchanges.forEach((ex) => {
                startAiMessage(ex.user, null);
                currentRaw = ex.assistant || '';
                if (currentAiEl) currentAiEl.innerHTML = formatAiHtml(currentRaw);
                currentAiEl = null;
              });
            } else if (chatEmpty) {
              chatList.appendChild(chatEmpty);
              chatEmpty.style.display = 'block';
            }
          } else if (event === 'capture:state') {
            applyStatus({ capturing: !!data.active });
          } else if (event === 'hide:state') {
            applyStatus({ hidden: !!data.hidden });
          } else if (event === 'smart:state') {
            applyStatus({ smart: !!data.smart });
          } else if (event === 'quick:state') {
            applyStatus({ quick: !!data.quick });
          } else if (event === 'vad:state') {
            dot.className = 'dot ' + (data.speaking ? 'speaking' : 'idle');
          } else if (event === 'questions:update') {
            renderQueue(data.items || []);
          } else if (event === 'transcript') {
            appendTranscript(data.channel, data.text);
          } else if (event === 'llm:start') {
            startAiMessage(data.userBubble, data.category);
          } else if (event === 'llm:token') {
            const stick = isNearBottom(chatList);
            if (!currentAiEl) startAiMessage(null, null);
            currentRaw += data.text || '';
            currentAiEl.innerHTML = formatAiHtml(currentRaw);
            if (stick) chatList.scrollTop = chatList.scrollHeight;
          } else if (event === 'llm:done') {
            currentAiEl = null;
            if (navigator.vibrate) navigator.vibrate(35);
          } else if (event === 'llm:error') {
            if (!currentAiEl) startAiMessage(null, null);
            currentRaw = data.message || 'Error';
            currentAiEl.innerHTML = formatAiHtml(currentRaw);
            currentAiEl = null;
          } else if (event === 'prep:update') {
            renderPrep(data.prep || {});
          } else if (event === 'chat:clear') {
            chatList.innerHTML = '';
            tsList.innerHTML = '';
            lastTsTurn = { you: null, them: null };
          }
        };
      }
      connect();
    })();
  </script>
</body>
</html>`;
}

function createPhoneCompanionServer({
  getSnapshot,
  onAction,
  host = '0.0.0.0',
  port = 47832,
  initialToken = '',
  onTokenChange = null
} = {}) {
  let token = (typeof initialToken === 'string' && initialToken.length >= 10)
    ? initialToken
    : crypto.randomBytes(9).toString('base64url');
  let server = null;
  let wss = null;
  let boundPort = null;
  const clients = new Set();

  function verifyToken(urlString) {
    try {
      const parsed = new URL(urlString, 'http://localhost');
      const candidate = parsed.searchParams.get('t') || '';
      if (!candidate || candidate.length !== token.length) return false;
      return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(token));
    } catch {
      return false;
    }
  }

  function broadcast(event, data) {
    if (!clients.size) return;
    const payload = JSON.stringify({ event, data });
    for (const client of clients) {
      if (client.readyState === 1) {
        try { client.send(payload); } catch { /* ignore */ }
      }
    }
  }

  async function start() {
    if (server) return getInfo();
    server = http.createServer((req, res) => {
      if (!verifyToken(req.url)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized — scan the current QR code in Cue Settings → Phone.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
      });
      res.end(buildPhoneHtml(token));
    });

    wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      if (!verifyToken(req.url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => {
      clients.add(ws);
      try {
        const snap = typeof getSnapshot === 'function' ? getSnapshot() : {};
        ws.send(JSON.stringify({ event: 'init', data: snap }));
      } catch { /* ignore */ }

      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw || ''));
          if (typeof onAction === 'function') onAction(msg);
        } catch { /* ignore */ }
      });

      ws.on('close', () => {
        clients.delete(ws);
      });
    });

    const listenOnPort = (targetPort) => new Promise((resolve, reject) => {
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const addr = server.address();
        boundPort = addr && typeof addr === 'object' ? addr.port : targetPort;
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(targetPort, host);
    });

    try {
      await listenOnPort(port);
    } catch (err) {
      if (port !== 0 && err && err.code === 'EADDRINUSE') {
        await listenOnPort(0);
      } else {
        throw err;
      }
    }

    return getInfo();
  }

  function regenerateToken() {
    token = crypto.randomBytes(9).toString('base64url');
    if (typeof onTokenChange === 'function') {
      try { onTokenChange(token); } catch { /* ignore */ }
    }
    for (const client of clients) {
      try { client.close(4001, 'Token rotated'); } catch { /* ignore */ }
    }
    clients.clear();
    return getInfo();
  }

  function getInfo() {
    const lanIps = getLanAddresses();
    const primaryIp = lanIps[0] || '127.0.0.1';
    const urls = (lanIps.length ? lanIps : ['127.0.0.1']).map(
      (ip) => `http://${ip}:${boundPort}/?t=${token}`
    );
    const primaryUrl = `http://${primaryIp}:${boundPort}/?t=${token}`;
    return {
      running: !!server && !!boundPort,
      port: boundPort,
      token,
      primaryUrl,
      urls,
      connectedClients: clients.size,
      qrSvg: boundPort ? generateQrSvg(primaryUrl) : ''
    };
  }

  async function stop() {
    for (const client of clients) {
      try { client. terminate(); } catch { /* ignore */ }
    }
    clients.clear();
    if (wss) {
      await new Promise((resolve) => wss.close(resolve));
      wss = null;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
      boundPort = null;
    }
  }

  return {
    start,
    stop,
    broadcast,
    regenerateToken,
    getInfo
  };
}

module.exports = { createPhoneCompanionServer, getLanAddresses };
