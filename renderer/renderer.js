/* cue renderer — UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const cue = window.cue; // exposed by preload
  const renderMarkdown = window.renderMarkdown;
  const renderMarkdownParts = window.renderMarkdownParts;
  const $ = (s) => document.querySelector(s);
  const isWindows = cue.platform === 'win32';
  const isMac = cue.platform === 'darwin';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('.tb-hide .chev').innerHTML = icon('chevron-down', { size: 14 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  $('#quit-btn').innerHTML = icon('x', { size: 14 });
  document.querySelector('.act[data-mode="assist"] .ic').innerHTML = icon('sparkles', { size: 16 });
  document.querySelector('.act[data-mode="say"] .ic').innerHTML = icon('wand-sparkles', { size: 16 });
  document.querySelector('.act[data-mode="followup"] .ic').innerHTML = icon('message-circle', { size: 16 });
  document.querySelector('.act[data-mode="recap"] .ic').innerHTML = icon('refresh-cw', { size: 16 });
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  const quickToggleIc = document.querySelector('#quick-toggle .ic');
  if (quickToggleIc) quickToggleIc.innerHTML = icon('zap', { size: 14 });
  const notesInsightsIc = document.querySelector('#notes-insights-btn .ic');
  if (notesInsightsIc) notesInsightsIc.innerHTML = icon('sparkles', { size: 13 });
  const notesQuestionsIc = document.querySelector('#notes-questions-btn .ic');
  if (notesQuestionsIc) notesQuestionsIc.innerHTML = icon('message-circle', { size: 13 });
  const notesToggleIc = document.querySelector('#notes-toggle .ic');
  if (notesToggleIc) notesToggleIc.innerHTML = icon('pencil', { size: 13 });
  const notesUpdateIc = document.querySelector('#notes-update-btn .ic');
  if (notesUpdateIc) notesUpdateIc.innerHTML = icon('refresh-cw', { size: 13 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });
  const clearIC = document.querySelector('#clear-transcript-btn .ic');
  if (clearIC) clearIC.innerHTML = icon('trash-2', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let whisperOverview = null;
  let busy = false;
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  // The answer being streamed. Blocks that are finished (everything before the
  // last blank line outside a code fence) are rendered once and left in the
  // page; only the block still being written is re-rendered per token. Before,
  // every token re-parsed the whole answer and rebuilt all of its DOM, so the
  // cost of an answer grew with the square of its length.
  let aiRaw = '';        // markdown received so far
  let aiFrozenChars = 0; // how much of aiRaw is already in the page for good
  let aiFrozenNodes = 0; // how many child nodes of aiEl that part produced
  let responseCount = 0;
  const MAX_RESPONSES = 20;

  const messages = $('#messages');

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; resetAiStream(); }

  function resetAiStream() {
    aiRaw = '';
    aiFrozenChars = 0;
    aiFrozenNodes = 0;
  }

  // The markdown behind an answer: live text for the one streaming, otherwise
  // what finalizeAi stored on the element.
  function rawOf(el) {
    return el && el === aiEl ? aiRaw : ((el && el.dataset.raw) || '');
  }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  // Wire up a fresh answer element as the streaming target.
  function beginAi(small) {
    resetAiStream();
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    return aiEl;
  }

  function startAi(small) {
    messages.appendChild(beginAi(small));
  }

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiRaw += t;
    const parts = renderMarkdownParts(aiRaw.slice(aiFrozenChars));
    // Drop last time's unfinished block (and the caret riding on it).
    while (aiEl.childNodes.length > aiFrozenNodes) aiEl.removeChild(aiEl.lastChild);
    if (parts.stableOffset > 0) {
      aiEl.insertAdjacentHTML('beforeend', parts.html.slice(0, parts.stableHtmlLength));
      aiFrozenChars += parts.stableOffset;
      aiFrozenNodes = aiEl.childNodes.length;
    }
    const unfinished = parts.html.slice(parts.stableHtmlLength);
    if (unfinished) aiEl.insertAdjacentHTML('beforeend', unfinished);
    if (caretEl) {
      const last = aiEl.lastElementChild;
      if (last && (last.tagName === 'UL' || last.tagName === 'OL') && last.lastElementChild) {
        last.lastElementChild.appendChild(caretEl);
      } else if (last && last.tagName === 'P') {
        last.appendChild(caretEl);
      } else {
        aiEl.appendChild(caretEl);
      }
    }
  }

  function copyToClipboard(text, toastMsg = 'Copied to clipboard') {
    if (!text) return;
    if (typeof cue.copyText === 'function') {
      cue.copyText(text);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    if (toastMsg) showToast(toastMsg, 1500);
  }

  function stripCodeComments(code) {
    return String(code || '')
      .split('\n')
      .filter((line) => !/^\s*(?:\/\/|#(?!!)|\/\*|\*\/|\*\s).*$/.test(line))
      .map((line) => line.replace(/\s+\/\/(?![/])\s.*$/, '').replace(/\s+#\s.*$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function enhanceCodeBlocks(container) {
    if (!container) return;
    container.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-toolbar')) return;
      const codeEl = pre.querySelector('code');
      if (!codeEl) return;
      const langClass = (codeEl.className || '').replace(/^language-/, '').trim();
      const bar = document.createElement('div');
      bar.className = 'code-toolbar';

      const langSpan = document.createElement('span');
      langSpan.className = 'code-lang';
      langSpan.textContent = langClass || 'code';

      const actions = document.createElement('div');
      actions.className = 'code-actions';

      const copyCleanBtn = document.createElement('button');
      copyCleanBtn.type = 'button';
      copyCleanBtn.className = 'code-copy-btn';
      copyCleanBtn.textContent = 'Copy clean';
      copyCleanBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const cleaned = stripCodeComments(codeEl.textContent || '');
        copyToClipboard(cleaned || (codeEl.textContent || '').trim(), 'Copied code (comments stripped)');
        copyCleanBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyCleanBtn.textContent = 'Copy clean'; }, 1400);
      });

      const copyRawBtn = document.createElement('button');
      copyRawBtn.type = 'button';
      copyRawBtn.className = 'code-copy-btn';
      copyRawBtn.textContent = 'Copy code';
      copyRawBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        copyToClipboard((codeEl.textContent || '').trim(), 'Copied code to clipboard');
        copyRawBtn.textContent = 'Copied ✓';
        setTimeout(() => { copyRawBtn.textContent = 'Copy code'; }, 1400);
      });

      actions.appendChild(copyCleanBtn);
      actions.appendChild(copyRawBtn);
      bar.appendChild(langSpan);
      bar.appendChild(actions);
      pre.insertBefore(bar, codeEl);
    });
  }

  // One full render at the end, so the finished answer never depends on how
  // it happened to be split while streaming.
  function finalizeAi() {
    if (!aiEl) return;
    aiEl.dataset.raw = aiRaw;
    aiEl.innerHTML = renderMarkdown(aiRaw);
    enhanceCodeBlocks(aiEl);
    aiEl = null; caretEl = null;
    resetAiStream();
  }

  let busyFailsafe = null;
  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    clearTimeout(busyFailsafe);
    // Failsafe: main has a 25s stream watchdog that always sends llm:done/llm:error, but if a
    // terminal event is ever lost the whole UI stays frozen — self-clear after a generous window.
    if (v) busyFailsafe = setTimeout(() => { busy = false; $('#send-btn').classList.toggle('busy', false); }, 40000);
  }

  // ---- toast helper ------------------------------------------------------
  // FIX #7: Toast queue system — ensures latest toast wins cleanly without stacking
  let toastTimer = null;
  let toastFadeTimer = null;
  function showToast(message, ms) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.getElementById('app').appendChild(el);
    }
    // Clear any pending timers to prevent overlap
    clearTimeout(toastTimer);
    clearTimeout(toastFadeTimer);
    // Immediately update content (no stacking)
    el.textContent = message;
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, ms);
  }

  // ---- actions -----------------------------------------------------------
  function runMode(mode, text) {
    if (busy) return;
    setBusy(true);
    cue.ask({ mode, text: text || '' });
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', () => runMode(btn.dataset.mode, ''));
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  // ========== QUESTION INPUT STATE ==========
  // True when the text in the box is a restored interviewer question (Ctrl+Z)
  // rather than something the user typed; such text is answered as a question
  // addressed to the user instead of a question about the screen.
  let inputFromSTT = false;

  // Question history for undo (Ctrl+Z)
  const questionHistory = [];
  const MAX_QUESTION_HISTORY = 10;

  // ---- Question completeness detection ----
  function isLikelyCompleteQuestion(text) {
    const trimmed = (text || '').trim();
    
    // Must be substantial (not just filler words)
    if (trimmed.length < 12) return false;
    
    // High confidence: ends with question mark
    if (/\?$/.test(trimmed)) return true;
    
    // High confidence: behavioral interview patterns (these are complete even without ?)
    const behavioralPatterns = [
      /tell me about a time/i,
      /give me an example/i,
      /describe a (situation|time|project|challenge)/i,
      /walk me through/i,
      /can you (tell|describe|explain|share)/i,
      /what (was|were|is|are) your/i,
      /how (did|do|would) you/i,
      /why (did|do|are|should)/i,
      /what (did|do|would) you/i,
      /tell me about yourself/i,
      /tell me about your/i,
      /what.{1,30}(biggest|greatest|most|hardest|proudest)/i,
      /have you ever/i
    ];
    if (behavioralPatterns.some(p => p.test(trimmed))) return true;
    
    // Medium confidence: question starters with substantial content
    const questionStarters = /^(what|how|why|when|where|who|which|tell|describe|explain|can|could|would|should|have|did|do|is|are|was|were)/i;
    if (questionStarters.test(trimmed) && trimmed.length > 25) return true;
    
    // Medium confidence: ends with common question endings
    if (/(about that|for us|to us|with you|for you|about it|to share|you handle|you approach|your experience|your background)\s*$/i.test(trimmed)) return true;
    
    return false;
  }

  // ---- Get question confidence level ----
  function getQuestionConfidence(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 8) return 'low';
    if (/\?$/.test(trimmed)) return 'high';
    if (isLikelyCompleteQuestion(trimmed)) return 'medium';
    if (trimmed.length > 20) return 'accumulating';
    return 'low';
  }

  // ---- Update visual state based on question readiness ----
  // FIX #8: Batch class updates to avoid flicker
  function updateQuestionReadyState() {
    const text = input.value;
    const confidence = getQuestionConfidence(text);
    
    // Batch the class changes to minimize repaints
    const shouldBeReady = confidence === 'high' || confidence === 'medium';
    const shouldBeAccumulating = confidence === 'accumulating';
    
    // Only update if state actually changed
    const isReady = composer.classList.contains('stt-ready');
    const isAccumulating = composer.classList.contains('stt-accumulating');
    
    if (shouldBeReady !== isReady || shouldBeAccumulating !== isAccumulating) {
      composer.classList.remove('stt-ready', 'stt-accumulating');
      if (shouldBeReady) {
        composer.classList.add('stt-ready');
      } else if (shouldBeAccumulating) {
        composer.classList.add('stt-accumulating');
      }
    }
    
    updateSendButtonState(); // FIX #9: Keep send button in sync
  }
  
  // FIX #9: Send button visual "ready" state
  function updateSendButtonState() {
    const sendBtn = document.getElementById('send-btn');
    if (!sendBtn) return;
    
    const hasText = input.value.trim().length > 0;
    const isReady = composer.classList.contains('stt-ready');
    
    sendBtn.classList.toggle('ready', hasText && isReady);
    sendBtn.classList.toggle('has-text', hasText);
  }

  // ---- Save question to history for undo ----
  function saveToQuestionHistory(text) {
    if (!text || text.trim().length < 5) return;
    
    // Don't save duplicates
    const last = questionHistory[questionHistory.length - 1];
    if (last && last.text === text.trim()) return;
    
    questionHistory.push({
      text: text.trim(),
      timestamp: Date.now()
    });
    
    // Keep only recent history
    while (questionHistory.length > MAX_QUESTION_HISTORY) {
      questionHistory.shift();
    }
    
    updateHistoryBadge(); // FIX #14: Update badge when history changes
  }
  
  // FIX #14: History button badge showing count
  function updateHistoryBadge() {
    const historyBtn = document.getElementById('history-btn');
    if (!historyBtn) return;
    
    // Remove existing badge if any
    let badge = historyBtn.querySelector('.history-badge');
    
    const count = questionHistory.length;
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'history-badge';
        historyBtn.appendChild(badge);
      }
      badge.textContent = count > 9 ? '9+' : count;
      badge.style.display = '';
    } else if (badge) {
      badge.style.display = 'none';
    }
  }

  // ---- Restore last question from history (Ctrl+Z) ----
  function restoreLastQuestion() {
    const last = questionHistory.pop();
    if (last) {
      input.value = last.text;
      inputFromSTT = true;
      lastSTTValue = last.text; // FIX #8: Track restored value for edit detection
      composer.classList.add('stt-filling');
      updateQuestionReadyState();
      syncPlaceholder();
      updateHistoryBadge(); // Update badge after removing from history
      showToast('Question restored', 1500);
      return true;
    }
    showToast('No question to restore', 1500);
    return false;
  }

  // ---- Hard clear (called when user explicitly clears or types) ----
  // FIX #10: Add option to show toast when clearing
  function hardClearSTTFill(showUndoHint = false) {
    const hadContent = input.value.trim().length > 0;
    saveToQuestionHistory(input.value);
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear the tracked STT value
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    updateHistoryBadge(); // FIX #14
    
    // FIX #10: Show undo hint when explicitly cleared
    if (showUndoHint && hadContent) {
      const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
      showToast(`Cleared · ${undoHint}`, 2000);
    }
  }

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  
  // FIX #6: Track last STT value to detect substantial edits vs minor corrections
  let lastSTTValue = '';

  // Pre-open the provider connection as soon as the user shows intent to ask
  // (focus or typing) — by the time they press Enter, TCP+TLS is already done.
  // Throttled here to keep IPC quiet; main dedupes per origin as well. The
  // interval is under the ~4s an idle connection survives for the fetch-based
  // providers (Gemini), so steady typing keeps the connection open.
  let lastWarmAt = 0;
  function warmLLM() {
    const now = Date.now();
    if (now - lastWarmAt < 3000) return;
    lastWarmAt = now;
    if (typeof cue.warm === 'function') cue.warm();
  }

  input.addEventListener('input', () => {
    warmLLM();
    const currentValue = input.value;

    // FIX #6: Only detach from STT mode if edit is substantial
    // Minor corrections (typo fixes, small additions) should keep STT mode
    if (inputFromSTT && lastSTTValue) {
      const lengthDiff = Math.abs(currentValue.length - lastSTTValue.length);
      const isCleared = currentValue.trim().length === 0;
      const isSubstantialChange = lengthDiff > lastSTTValue.length * 0.3 || isCleared;
      
      if (isSubstantialChange) {
        // User made a major change — detach from STT mode
        saveToQuestionHistory(lastSTTValue);
        inputFromSTT = false;
        lastSTTValue = '';
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
      }
      // Minor edits: keep inputFromSTT = true, just update visual state
    } else if (!inputFromSTT) {
      // User typing from scratch — standard behavior
      composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    }
    
    syncPlaceholder();
    updateSendButtonState(); // FIX #9: Update send button on input change
  });
  // ---- on-demand focusable helper (prevents focus theft on button clicks) ----
  let releaseFocusTimer = null;
  function requestWindowFocus(elToFocus) {
    clearTimeout(releaseFocusTimer);
    if (typeof cue.setFocusable === 'function') cue.setFocusable(true);
    if (elToFocus && typeof elToFocus.focus === 'function') {
      elToFocus.focus();
      requestAnimationFrame(() => {
        if (document.activeElement !== elToFocus) elToFocus.focus();
      });
      setTimeout(() => {
        if (document.activeElement !== elToFocus) elToFocus.focus();
      }, 35);
    }
  }
  function releaseWindowFocusIfIdle() {
    clearTimeout(releaseFocusTimer);
    releaseFocusTimer = setTimeout(() => {
      const scrimEl = document.getElementById('settings-scrim');
      if (scrimEl && !scrimEl.classList.contains('hidden')) return;
      const active = document.activeElement;
      const inTextInput = active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable);
      if (!inTextInput && typeof cue.setFocusable === 'function') {
        cue.setFocusable(false);
      }
    }, 180);
  }

  input.addEventListener('mouseenter', () => {
    clearTimeout(releaseFocusTimer);
    if (typeof cue.setFocusable === 'function') cue.setFocusable({ focusable: true, activate: false });
  });
  $('#input-area').addEventListener('mouseenter', () => {
    clearTimeout(releaseFocusTimer);
    if (typeof cue.setFocusable === 'function') cue.setFocusable({ focusable: true, activate: false });
  });
  $('#input-area').addEventListener('mouseleave', () => releaseWindowFocusIfIdle());
  input.addEventListener('mousedown', () => requestWindowFocus(input));
  input.addEventListener('focus', () => { warmLLM(); composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); releaseWindowFocusIfIdle(); });
  $('#input-area').addEventListener('mousedown', () => requestWindowFocus(input));
  $('#input-area').addEventListener('click', () => requestWindowFocus(input));

  function send() {
    const text = input.value.trim();
    if (!text) { runMode('assist', ''); return; }
    const wasFromSTT = inputFromSTT;
    
    // Save to history before clearing (in case user wants to redo)
    saveToQuestionHistory(text);
    
    input.value = '';
    inputFromSTT = false;
    lastSTTValue = ''; // FIX #6: Clear tracked STT value
    composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
    syncPlaceholder();
    updateSendButtonState(); // FIX #9
    input.blur();
    releaseWindowFocusIfIdle();
    
    // If text came from STT (interviewer question), use answerThis mode
    // Otherwise use ask mode (user typed their own question)
    runMode(wasFromSTT ? 'answerThis' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Ctrl+Z / Cmd+Z: restore last question if input is empty
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !input.value.trim()) {
      e.preventDefault();
      restoreLastQuestion();
      return;
    }
    // Escape: clear the input (with undo hint)
    if (e.key === 'Escape' && input.value.trim()) {
      e.preventDefault();
      hardClearSTTFill(true); // FIX #10: Show undo hint
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); send(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runMode('assist', ''); }
  });
  
  // FIX #13: Global keyboard shortcut for force-answer (Ctrl+Shift+A / Cmd+Shift+A)
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+A / Cmd+Shift+A: Force answer current question immediately
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      if (input.value.trim()) {
        send();
      } else if (inputFromSTT || composer.classList.contains('stt-filling')) {
        // Even if question seems incomplete, force send
        send();
      } else {
        showToast('No question to answer', 1500);
      }
    }
  });
  
  // Smart & Quick toggles
  const smartBtn = $('#smart-toggle');
  const quickBtn = $('#quick-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    if (settings.smart) settings.quick = false;
    smartBtn.classList.toggle('on', settings.smart);
    if (quickBtn) quickBtn.classList.toggle('on', !!settings.quick);
    await cue.settingsSet({ smart: settings.smart, quick: !!settings.quick });
  });
  if (quickBtn) {
    quickBtn.addEventListener('click', async () => {
      settings.quick = !settings.quick;
      if (settings.quick) settings.smart = false;
      quickBtn.classList.toggle('on', settings.quick);
      smartBtn.classList.toggle('on', !!settings.smart);
      await cue.settingsSet({ quick: settings.quick, smart: !!settings.smart });
      showToast(settings.quick ? 'Quick mode ON — zero context for instant gotcha answers' : 'Quick mode OFF — full interview context active', 2000);
    });
  }
  cue.on('smart:state', ({ smart }) => {
    if (settings) settings.smart = !!smart;
    smartBtn.classList.toggle('on', !!smart);
  });
  cue.on('quick:state', ({ quick }) => {
    if (settings) settings.quick = !!quick;
    if (quickBtn) quickBtn.classList.toggle('on', !!quick);
  });

  // ---- Live Notetaking Mode (Separate from Q&A Chat) ----------------------
  const notesBtn = document.getElementById('notes-toggle');
  const notesInsightsBtn = document.getElementById('notes-insights-btn');
  const notesInsightsLabel = document.getElementById('notes-insights-label');
  const notesQuestionsBtn = document.getElementById('notes-questions-btn');
  const notesQuestionsLabel = document.getElementById('notes-questions-label');
  const notesPanel = document.getElementById('notes-panel');
  const notesBody = document.getElementById('notes-body');
  const notesEngineBadge = document.getElementById('notes-engine-badge');
  const notesUpdateBtn = document.getElementById('notes-update-btn');
  const notesUpdateLabel = document.getElementById('notes-update-label');
  const notesDeltaBadge = document.getElementById('notes-delta-badge');
  const notesCopyBtn = document.getElementById('notes-copy-btn');
  const notesClearBtn = document.getElementById('notes-clear-btn');

  let notesModeActive = false;
  let notesRawMarkdown = '';
  let notesSavedMarkdown = '';
  let notesBusy = false;
  let incrementalTarget = { beforeText: '', afterText: '', mode: 'full' };
  let incrementalStreamTokens = '';
  let lastNotesInputAt = 0;
  let autoNotesTimer = null;
  let lastAutoAttemptTurnCount = -1;
  let lastNotesPublicState = null;
  const AUTO_NOTES_TYPING_IDLE_MS = 3000;

  // Every edit sends the whole document to the main process. Doing that on
  // each keystroke is wasted work, so typing is sent once it pauses. Anything
  // that needs the current text right away (leaving the editor, switching
  // modes) sends immediately, and anything that supersedes it (starting a
  // generation, clearing) drops the pending send so a stale copy cannot land
  // on top of newer notes.
  const NOTES_EDIT_DEBOUNCE_MS = 400;
  let notesEditTimer = null;
  let pendingNotesEdit = null;
  function dropPendingNotesEdit() {
    clearTimeout(notesEditTimer);
    notesEditTimer = null;
    pendingNotesEdit = null;
  }
  function flushNotesEdit() {
    const text = pendingNotesEdit;
    dropPendingNotesEdit();
    if (text !== null && typeof cue.notesEdit === 'function') cue.notesEdit(text);
  }
  function queueNotesEdit(text) {
    pendingNotesEdit = text;
    clearTimeout(notesEditTimer);
    notesEditTimer = setTimeout(flushNotesEdit, NOTES_EDIT_DEBOUNCE_MS);
  }
  function sendNotesEditNow(text) {
    pendingNotesEdit = text;
    flushNotesEdit();
  }

  function formatNotesForEditor(raw) {
    return String(raw || '')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`[-*•]\s*`/g, '')
      .replace(/^\s*[-*•]\s+(?:`?[-*•]`?\s*)+/gm, '- ')
      .replace(/^\s*[-*•]\s+/gm, '- ');
  }

  function updateNotesEditorPreservingCursor(newValue) {
    if (!notesBody) return;
    const hadFocus = document.activeElement === notesBody;
    const selStart = hadFocus ? notesBody.selectionStart : null;
    const selEnd = hadFocus ? notesBody.selectionEnd : null;
    const prevScroll = notesBody.scrollTop;
    const stickToBottom = isNearBottom(notesBody, 120);
    const preserveMidCursor =
      hadFocus &&
      incrementalTarget.mode === 'append' &&
      typeof selEnd === 'number' &&
      selEnd <= incrementalTarget.beforeText.length;

    notesBody.value = newValue;

    if (preserveMidCursor) {
      try {
        notesBody.setSelectionRange(selStart, selEnd);
        notesBody.scrollTop = prevScroll;
      } catch (_) {}
    } else if (stickToBottom) {
      notesBody.scrollTop = notesBody.scrollHeight;
    }
  }

  function setNotesModeUI(active) {
    notesModeActive = !!active;
    if (!notesModeActive && autoNotesTimer) {
      clearTimeout(autoNotesTimer);
      autoNotesTimer = null;
    }
    if (notesBtn) notesBtn.classList.toggle('on', notesModeActive);
    if (notesPanel) notesPanel.classList.toggle('hidden', !notesModeActive);
    if (smartBtn) smartBtn.classList.toggle('hidden', notesModeActive);
    if (quickBtn) quickBtn.classList.toggle('hidden', notesModeActive);
    if (notesInsightsBtn) notesInsightsBtn.classList.toggle('hidden', !notesModeActive);
    if (notesQuestionsBtn) notesQuestionsBtn.classList.toggle('hidden', !notesModeActive);
    const messagesEl = document.getElementById('messages');
    const qqEl = document.getElementById('question-queue');
    if (messagesEl) messagesEl.classList.toggle('hidden', notesModeActive);
    if (notesModeActive && qqEl) qqEl.classList.add('hidden');
  }

  function resetNotesActionLabels() {
    if (notesUpdateLabel) notesUpdateLabel.textContent = 'Update Notes';
    if (notesInsightsLabel) notesInsightsLabel.textContent = 'Insights';
    if (notesQuestionsLabel) notesQuestionsLabel.textContent = 'Questions';
    if (notesInsightsBtn) notesInsightsBtn.classList.remove('busy');
    if (notesQuestionsBtn) notesQuestionsBtn.classList.remove('busy');
  }

  function triggerNotesTask(task, opts = {}) {
    if (notesBusy) return;
    if (autoNotesTimer) {
      clearTimeout(autoNotesTimer);
      autoNotesTimer = null;
    }
    const currentNotes = notesBody ? notesBody.value.trim() : notesSavedMarkdown;
    notesSavedMarkdown = currentNotes;
    dropPendingNotesEdit(); // the request below carries the current text
    if (typeof cue.notesGenerate === 'function') {
      cue.notesGenerate({ currentNotes, forceFull: false, task, auto: !!opts.auto });
    }
  }

  function scheduleAutoNotesCheck(st) {
    if (!st || !notesModeActive || notesBusy || st.busy) return;
    if (!st.autoShouldUpdate) return;
    const totalTurns = Number(st.totalTurns) || 0;
    if (totalTurns <= lastAutoAttemptTurnCount) return;

    const msSinceTyping = Date.now() - lastNotesInputAt;
    if (msSinceTyping < AUTO_NOTES_TYPING_IDLE_MS) {
      clearTimeout(autoNotesTimer);
      const waitMs = Math.max(100, AUTO_NOTES_TYPING_IDLE_MS - msSinceTyping + 50);
      autoNotesTimer = setTimeout(() => {
        autoNotesTimer = null;
        if (notesModeActive && !notesBusy && lastNotesPublicState && lastNotesPublicState.autoShouldUpdate) {
          scheduleAutoNotesCheck(lastNotesPublicState);
        }
      }, waitMs);
      return;
    }

    lastAutoAttemptTurnCount = totalTurns;
    triggerNotesTask('update', { auto: true });
  }

  async function toggleNotesMode(forceState) {
    const next = typeof forceState === 'boolean' ? forceState : !notesModeActive;
    if (!next && notesBody && !notesBusy) {
      const currentMd = notesBody.value;
      notesSavedMarkdown = currentMd;
      sendNotesEditNow(currentMd);
    }
    setNotesModeUI(next);
    if (typeof cue.notesModeSet === 'function') {
      try {
        const pub = await cue.notesModeSet(next);
        syncNotesStateUI(pub);
      } catch (_) {}
    }
  }

  function syncNotesStateUI(st) {
    if (!st) return;
    lastNotesPublicState = st;
    if ((Number(st.totalTurns) || 0) === 0) {
      lastAutoAttemptTurnCount = -1;
    }
    if (notesEngineBadge && st.engineLabel) {
      notesEngineBadge.textContent = st.engineLabel;
    }
    if (notesDeltaBadge) {
      const pending = Number(st.pendingTurns) || 0;
      if (pending > 0 && !notesBusy) {
        notesDeltaBadge.textContent = `+${pending} new`;
        notesDeltaBadge.classList.remove('hidden');
      } else {
        notesDeltaBadge.classList.add('hidden');
      }
    }
    if (!notesBusy && typeof st.markdown === 'string' && document.activeElement !== notesBody) {
      notesSavedMarkdown = st.markdown;
      if (st.markdown && notesBody && !notesBody.value) {
        notesRawMarkdown = st.markdown;
        notesBody.value = formatNotesForEditor(st.markdown);
      }
    }
    scheduleAutoNotesCheck(st);
  }

  if (notesBtn) {
    notesBtn.addEventListener('click', () => toggleNotesMode());
  }
  if (notesBody) {
    notesBody.addEventListener('mouseenter', () => {
      clearTimeout(releaseFocusTimer);
      if (typeof cue.setFocusable === 'function') cue.setFocusable({ focusable: true, activate: false });
    });
    notesBody.addEventListener('mouseleave', () => releaseWindowFocusIfIdle());
    notesBody.addEventListener('mousedown', () => requestWindowFocus(notesBody));
    notesBody.addEventListener('click', () => requestWindowFocus(notesBody));
    notesBody.addEventListener('keydown', (e) => {
      lastNotesInputAt = Date.now();
      e.stopPropagation();
    });
    notesBody.addEventListener('blur', () => {
      if (!notesBusy) {
        const edited = notesBody.value;
        notesSavedMarkdown = edited;
        notesRawMarkdown = edited;
        sendNotesEditNow(edited);
      }
      releaseWindowFocusIfIdle();
    });
    notesBody.addEventListener('input', () => {
      lastNotesInputAt = Date.now();
      if (!notesBusy) {
        const edited = notesBody.value;
        notesSavedMarkdown = edited;
        notesRawMarkdown = edited;
        queueNotesEdit(edited);
      }
    });
  }
  if (notesUpdateBtn) {
    notesUpdateBtn.addEventListener('click', () => triggerNotesTask('update'));
  }
  if (notesInsightsBtn) {
    notesInsightsBtn.addEventListener('click', () => triggerNotesTask('insights'));
  }
  if (notesQuestionsBtn) {
    notesQuestionsBtn.addEventListener('click', () => triggerNotesTask('questions'));
  }
  if (notesCopyBtn) {
    notesCopyBtn.addEventListener('click', () => {
      const currentNotes = notesBody ? notesBody.value.trim() : '';
      const textToCopy = (currentNotes || notesSavedMarkdown || notesRawMarkdown || '').trim();
      if (!textToCopy) return;
      copyToClipboard(textToCopy, 'Copied notes');
    });
  }
  if (notesClearBtn) {
    notesClearBtn.addEventListener('click', async () => {
      if (notesBusy) return;
      if (autoNotesTimer) {
        clearTimeout(autoNotesTimer);
        autoNotesTimer = null;
      }
      notesRawMarkdown = '';
      notesSavedMarkdown = '';
      if (notesBody) notesBody.value = '';
      dropPendingNotesEdit(); // or a late send would put the cleared notes back
      if (typeof cue.notesClear === 'function') {
        const pub = await cue.notesClear();
        lastAutoAttemptTurnCount = Number(pub && pub.totalTurns) || 0;
        syncNotesStateUI(pub);
      }
    });
  }

  cue.on('notes:state', (st) => syncNotesStateUI(st));
  cue.on('notes:start', ({ engineLabel, task, isDelta, isAuto }) => {
    notesBusy = true;
    notesRawMarkdown = '';
    incrementalStreamTokens = '';
    if (notesEngineBadge && engineLabel) notesEngineBadge.textContent = engineLabel;
    if (task === 'insights') {
      if (notesInsightsLabel) notesInsightsLabel.textContent = 'Insights…';
      if (notesInsightsBtn) notesInsightsBtn.classList.add('busy');
    } else if (task === 'questions') {
      if (notesQuestionsLabel) notesQuestionsLabel.textContent = 'Questions…';
      if (notesQuestionsBtn) notesQuestionsBtn.classList.add('busy');
    } else {
      if (notesUpdateLabel) notesUpdateLabel.textContent = isAuto ? 'Auto-updating…' : 'Updating…';
    }
    if (notesDeltaBadge) notesDeltaBadge.classList.add('hidden');

    const currentText = notesBody ? notesBody.value : (notesSavedMarkdown || '');
    const cleanCurrent = currentText.trim();
    if (!cleanCurrent || (task === 'update' && !isDelta)) {
      incrementalTarget = { beforeText: '', afterText: '', mode: 'full' };
    } else {
      incrementalTarget = {
        beforeText: cleanCurrent + '\n\n',
        afterText: '',
        mode: 'append'
      };
    }
  });

  cue.on('notes:token', ({ text }) => {
    notesRawMarkdown += text;
    incrementalStreamTokens += text;
    if (notesBody) {
      const cleanChunk = formatNotesForEditor(incrementalStreamTokens);
      let preview = '';
      if (incrementalTarget.mode === 'append') {
        preview = incrementalTarget.beforeText + cleanChunk;
      } else {
        preview = cleanChunk;
      }
      updateNotesEditorPreservingCursor(preview);
    }
  });

  cue.on('notes:done', (st) => {
    notesBusy = false;
    resetNotesActionLabels();
    if (st && st.markdown) {
      const clean = formatNotesForEditor(st.markdown);
      notesSavedMarkdown = clean;
      notesRawMarkdown = clean;
      updateNotesEditorPreservingCursor(clean);
    }
    // A long backlog of speech is written up in slices. If this update stopped
    // short of the latest turn, let the auto-update pick up the next slice now
    // instead of waiting for someone to speak again.
    if (st && Number(st.pendingTurns) > 0 && st.autoShouldUpdate) lastAutoAttemptTurnCount = -1;
    syncNotesStateUI(st);
  });
  cue.on('notes:error', ({ message }) => {
    notesBusy = false;
    resetNotesActionLabels();
    if (notesSavedMarkdown && notesBody) {
      notesBody.value = formatNotesForEditor(notesSavedMarkdown);
    }
    if (message) showToast(message, 2500);
  });

  // Hide / collapse (hides everything including top bar and modals so 0 UI shows on screen)
  function setHidden(hidden) {
    const collapsed = !!hidden;
    $('#panel').classList.toggle('collapsed', collapsed);
    $('#app').classList.toggle('app-hidden', collapsed);
    document.body.classList.toggle('app-hidden', collapsed);
    $('#hide-btn').classList.toggle('collapsed', collapsed);
    $('#live-dot').style.display = collapsed ? 'none' : '';
    const sidebar = document.getElementById('transcript-sidebar');
    if (sidebar) {
      sidebar.classList.toggle('hidden', collapsed || !sidebarOpen);
    }
    if (collapsed && typeof cue.setFocusable === 'function') {
      cue.setFocusable(false);
    }
    if (typeof cue.setHiddenState === 'function') {
      cue.setHiddenState(collapsed);
    }
    syncClickThrough();
  }
  function toggleHide() {
    setHidden(!$('#panel').classList.contains('collapsed'));
  }
  $('#hide-btn').addEventListener('click', toggleHide);
  cue.on('hide:toggle', toggleHide);

  $('#quit-btn').addEventListener('click', () => cue.quit());

  // Focus-input hotkey (Ctrl/Cmd+Shift+Space): expand the panel if collapsed,
  // stop the window from passing the mouse through, and drop the caret in the box.
  cue.on('focus:input', () => {
    if ($('#panel').classList.contains('collapsed')) setHidden(false);
    setIgnore(false);
    requestWindowFocus(input);
  });

  // Stop = start/stop listening. Kick off system-audio capture straight from the click so
  // the user-gesture is fresh for getDisplayMedia (loopback capture needs it).
  $('#stop-btn').addEventListener('click', async () => {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) {
      // startSystemAudio may fail (user cancels, no permission) — that's OK,
      // mic will still work and capture will toggle regardless
      try { await startSystemAudio(); } catch (_) { /* handled inside startSystemAudio */ }
    }
    const active = await cue.captureToggle();
    if (turningOn && !active) stopSystemAudio();
  });

  // Transcript toggle removed — sidebar now auto-opens with listening

  // Clear transcript
  async function clearAllHistory() {
    // Save current input to history before clearing (for undo)
    saveToQuestionHistory(input.value);

    await cue.clearTranscript();
    clearMessages();
    // Also clear the floating interim bar
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    // FIX #1: Use ts-list instead of non-existent transcript-list
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    clearTranscriptSidebar(); // clear the history sidebar too
    hardClearSTTFill(); // clear the input box too

    const undoHint = isWindows ? 'Ctrl+Z to undo' : '⌘Z to undo';
    showToast(`Transcript cleared · ${undoHint}`, 3500);
  }
  const clearTranscriptBtn = document.getElementById('clear-transcript-btn');
  if (clearTranscriptBtn) {
    clearTranscriptBtn.addEventListener('click', clearAllHistory);
  }
  // Global hotkey (Ctrl/Cmd+Shift+Backspace) fires the same clear from anywhere.
  cue.on('chat:clear', clearAllHistory);

  // ---- capture: mic (renderer side) — uses AudioWorklet (modern, off-main-thread) ----
  let audioCtx = null, micStream = null, micWorklet = null, micStarting = false;
  async function startMic() {
    if (micStream || micStarting) return;
    micStarting = true;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 16000
        }
      });
      // getUserMedia can resolve with a stream that has no usable audio track
      // (e.g. a virtual/placeholder device, or a device that was unplugged
      // between permission grant and capture start). Fail loudly here instead
      // of silently wiring up an AudioWorklet to nothing — that produces the
      // "cue never hears me, no error shown" symptom with no diagnostic at all.
      const [track] = micStream.getAudioTracks();
      if (!track) {
        micStream.getTracks().forEach((t) => t.stop());
        micStream = null;
        showStatus('No microphone audio track was available. Check Windows Sound settings for a working default input device, then try again.');
        return;
      }
      cue.log('mic stream started: track=' + (track.label || '(no label — permission may be stale)') + ' muted=' + track.muted);
      audioCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for low-latency, off-main-thread processing
      try {
        await audioCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = audioCtx.createMediaStreamSource(micStream);
        micWorklet = new AudioWorkletNode(audioCtx, 'cue-audio-processor');
        micWorklet.port.onmessage = (e) => {
          cue.micPcm(e.data);
        };
        source.connect(micWorklet);
        // Don't connect to destination — we just capture, don't play
        cue.log('mic AudioWorklet processor attached');
      } catch (workletErr) {
        // Fallback to ScriptProcessor if AudioWorklet fails (shouldn't happen in Electron 33+)
        cue.log('AudioWorklet failed, falling back to ScriptProcessor: ' + workletErr.message);
        const micNode = audioCtx.createMediaStreamSource(micStream);
        const micProc = audioCtx.createScriptProcessor(4096, 1, 1);
        const sink = audioCtx.createGain(); sink.gain.value = 0;
        micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
        micProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.micPcm(out.buffer);
        };
        micWorklet = { _legacy: true, proc: micProc, node: micNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const name = err && err.name;
      cue.log('mic error: ' + name + ' — ' + message);
      // getUserMedia's DOMException.name is the reliable signal here — the
      // .message text varies by Chromium version and isn't meant for users.
      // Distinguishing "no device" from "denied" from "in use elsewhere"
      // turns one generic dead end into three different next actions.
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        showStatus('No microphone was found. Plug one in, or pick a default input device in your OS sound settings, then try again.');
      } else if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        showStatus(isWindows
          ? 'Microphone permission was denied. Settings → Privacy & security → Microphone → allow cue, then try again.'
          : 'Microphone permission was denied. System Settings → Privacy & Security → Microphone → allow cue, then try again.');
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        showStatus('The microphone could not be started — another application may be using it exclusively. Close other apps using the mic and try again.');
      } else {
        showStatus('Microphone capture could not be started. Check your mic permissions and try again.');
      }
    } finally {
      micStarting = false;
    }
  }
  function stopMic() {
    if (micWorklet) {
      if (micWorklet._legacy) {
        micWorklet.proc.disconnect(); micWorklet.proc.onaudioprocess = null;
        micWorklet.node.disconnect(); micWorklet.sink.disconnect();
      } else {
        micWorklet.disconnect();
      }
      micWorklet = null;
    }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in cue's process) ----
  let sysStream = null, sysCtx = null, sysWorklet = null, sysStarting = false;
  async function startSystemAudio() {
    // Called both from the stop-btn click (fresh user gesture for getDisplayMedia) and from the
    // capture:state handler. getDisplayMedia is async, so `if (sysStream) return` alone loses the
    // race and can open a second loopback stream that is then orphaned.
    if (sysStream || sysStarting) return;
    sysStarting = true;
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      cue.log('system audio unavailable: getDisplayMedia not supported');
      showStatus('Meeting audio capture is not available on this device build.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) {
        cue.log('system audio: no loopback track on this platform');
        stream.getTracks().forEach((t) => t.stop());
        showStatus(cue.platform === 'win32'
          ? 'No system-audio loopback track detected. Make sure "Share audio" is checked in the screen share dialog, and that your audio device is not in exclusive mode.'
          : 'No system-audio loopback track detected. Meeting audio needs macOS 14.4+ — your screen and microphone still work.');
        return;
      }
      sysStream = stream;
      sysCtx = new AudioContext({ sampleRate: 16000 });

      // Use AudioWorklet for system audio too
      try {
        await sysCtx.audioWorklet.addModule('audio-worklet-processor.js');
        const source = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        sysWorklet = new AudioWorkletNode(sysCtx, 'cue-audio-processor');
        sysWorklet.port.onmessage = (e) => {
          cue.systemPcm(e.data);
        };
        source.connect(sysWorklet);
        cue.log('system audio: AudioWorklet capturing loopback');
      } catch (workletErr) {
        // Fallback to ScriptProcessor
        cue.log('system audio AudioWorklet failed, using ScriptProcessor: ' + workletErr.message);
        const sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
        const sysProc = sysCtx.createScriptProcessor(4096, 1, 1);
        const sink = sysCtx.createGain(); sink.gain.value = 0;
        sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
        sysProc.onaudioprocess = (e) => {
          const f = e.inputBuffer.getChannelData(0);
          const out = new Int16Array(f.length);
          for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
          cue.systemPcm(out.buffer);
        };
        sysWorklet = { _legacy: true, proc: sysProc, node: sysNode, sink };
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      cue.log('system audio error: ' + message);
      showStatus('Meeting audio could not be started. Grant screen/audio access to cue and try again.');
    } finally {
      sysStarting = false;
    }
  }
  function stopSystemAudio() {
    if (sysWorklet) {
      if (sysWorklet._legacy) {
        sysWorklet.proc.disconnect(); sysWorklet.proc.onaudioprocess = null;
        sysWorklet.node.disconnect(); sysWorklet.sink.disconnect();
      } else {
        sysWorklet.disconnect();
      }
      sysWorklet = null;
    }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- STT / VAD status helpers ------------------------------------------
  // Live dot states: 'off' | 'idle' | 'speaking' | 'transcribing'
  function setLiveDotState(dotState) {
    const dot = document.getElementById('live-dot');
    if (!dot) return;
    dot.classList.remove('off', 'idle', 'speaking', 'transcribing');
    dot.classList.add(dotState);
  }

  let sttState = 'disconnected';

  function updateSttStatus({ active, streaming } = {}) {
    const label = document.getElementById('stt-status');
    if (!label) return;
    if (active === false) {
      sttState = 'disconnected';
      label.textContent = 'off';
    } else if (active === true) {
      sttState = streaming ? 'connecting' : 'batch';
      label.textContent = sttState;
    }
    label.className = 'stt-status stt-' + sttState;
  }

  // ---- transcript history sidebar (hidden by default, manual toggle) ----
  let tsSidebarInterimEl = null;
  let sidebarOpen = false;
  // Track last committed row per channel — all chunks from same speaker go in one row
  const tsLastRow = { you: null, them: null };
  const tsRowTimer = { you: null, them: null };
  const TS_SENTENCE_GAP_MS = 10000; // 10s silence = new row

  function showSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.remove('hidden');
    if (historyBtn) historyBtn.classList.add('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.add('sidebar-open');
    sidebarOpen = true;
  }

  function hideSidebar() {
    const sidebar = document.getElementById('transcript-sidebar');
    const historyBtn = document.getElementById('history-btn');
    if (sidebar) sidebar.classList.add('hidden');
    if (historyBtn) historyBtn.classList.remove('active');
    const panelWrap = document.getElementById('panel-wrap');
    if (panelWrap) panelWrap.classList.remove('sidebar-open');
    sidebarOpen = false;
  }

  function toggleSidebar() {
    if (sidebarOpen) {
      hideSidebar();
    } else {
      showSidebar();
      // FIX #7: Scroll to bottom when opening sidebar
      const list = document.getElementById('ts-list');
      if (list) {
        requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight;
        });
      }
    }
  }

  // History button toggle
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) {
    historyBtn.innerHTML = icon('message-square-text', { size: 15 });
    historyBtn.addEventListener('click', toggleSidebar);
  }

  // Close sidebar button
  const closeSidebarBtn = document.getElementById('close-sidebar-btn');
  if (closeSidebarBtn) {
    closeSidebarBtn.addEventListener('click', hideSidebar);
  }

  // ---- Click conversation history turn to instantly ask it to chat ----
  function askHistoryQuestion(rawText) {
    const text = (rawText || '').trim();
    if (!text || text.length < 2) return;
    if (busy) {
      showToast('Still answering previous question…', 1500);
      return;
    }
    if (notesModeActive) {
      setNotesModeUI(false);
      if (typeof cue.notesModeSet === 'function') cue.notesModeSet(false).catch(() => {});
    }
    hardClearSTTFill();
    runMode('ask', text);
  }

  const tsListEl = document.getElementById('ts-list');
  if (tsListEl) {
    tsListEl.addEventListener('click', (e) => {
      // If user was highlighting text to copy, don't trigger the click-to-ask
      const sel = window.getSelection ? window.getSelection().toString().trim() : '';
      if (sel.length > 0) return;

      const turn = e.target.closest('.ts-turn');
      if (!turn) return;

      const txt = turn.querySelector('.ts-text');
      const textToAsk = (txt ? txt.textContent : turn.textContent.replace(/^(Them|You)\s*/i, '')).trim();
      if (textToAsk && textToAsk.length >= 2) {
        askHistoryQuestion(textToAsk);
      }
    });
  }

  function isNearBottom(el, threshold = 48) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
  }

  function appendTranscriptHistoryTurn(channel, text, isInterim) {
    const list = document.getElementById('ts-list');
    if (!list) return;

    // Only auto-scroll if the user hasn't scrolled up to read earlier history.
    const stickToBottom = isNearBottom(list);

    // Remove placeholder on first real turn
    const ph = list.querySelector('.ts-placeholder');
    if (ph) ph.remove();

    if (isInterim) {
      // Update the single floating interim row
      if (!tsSidebarInterimEl) {
        tsSidebarInterimEl = document.createElement('div');
        tsSidebarInterimEl.className = 'ts-turn ts-' + channel + ' ts-interim-row';
        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';
        const txt = document.createElement('span');
        txt.className = 'ts-text ts-interim';
        tsSidebarInterimEl.appendChild(chLabel);
        tsSidebarInterimEl.appendChild(txt);
        list.appendChild(tsSidebarInterimEl);
      }
      tsSidebarInterimEl.querySelector('.ts-text').textContent = text;
      if (stickToBottom) list.scrollTop = list.scrollHeight;
    } else {
      // Remove interim row
      if (tsSidebarInterimEl) { tsSidebarInterimEl.remove(); tsSidebarInterimEl = null; }

      const existingRow = tsLastRow[channel];
      const useExisting = existingRow && existingRow.isConnected;

      if (useExisting) {
        // Append to existing row — accumulates sentence fragments
        const txt = existingRow.querySelector('.ts-text');
        if (txt) {
          txt.textContent = txt.textContent ? txt.textContent + ' ' + text : text;
        }
      } else {
        // Start a new row (no buttons — just clean history view)
        const row = document.createElement('div');
        row.className = 'ts-turn ts-' + channel;

        const chLabel = document.createElement('span');
        chLabel.className = 'ts-channel';
        chLabel.textContent = channel === 'them' ? 'Them' : 'You';

        const txt = document.createElement('span');
        txt.className = 'ts-text';
        txt.textContent = text;

        row.appendChild(chLabel);
        row.appendChild(txt);
        list.appendChild(row);
        tsLastRow[channel] = row;
      }

      // Reset silence timer
      clearTimeout(tsRowTimer[channel]);
      tsRowTimer[channel] = setTimeout(() => { tsLastRow[channel] = null; }, TS_SENTENCE_GAP_MS);

      // When THIS channel speaks, reset the OTHER channel's row
      const other = channel === 'you' ? 'them' : 'you';
      clearTimeout(tsRowTimer[other]);
      tsLastRow[other] = null;

      if (stickToBottom) list.scrollTop = list.scrollHeight;
    }
  }

  function clearTranscriptSidebar() {
    const list = document.getElementById('ts-list');
    if (list) list.innerHTML = '<div class="ts-placeholder">Conversation history will appear here when listening.</div>';
    tsSidebarInterimEl = null;
    tsLastRow.you = null; tsLastRow.them = null;
    clearTimeout(tsRowTimer.you); clearTimeout(tsRowTimer.them);
  }

  // ---- events from main --------------------------------------------------
  cue.on('capture:state', ({ active, streaming, mode }) => {
    setLiveDotState(active ? 'idle' : 'off');
    $('#stop-btn').classList.toggle('active', active);
    // FIX #4: Add .listening class to composer when capture is active
    composer.classList.toggle('listening', active);
    // Update history button to show active state when listening
    const historyBtn = document.getElementById('history-btn');
    if (historyBtn) {
      historyBtn.classList.toggle('listening', active);
    }
    // startSystemAudio() is called directly from the stop-button click handler
    // so that the getDisplayMedia request has a fresh user gesture.
    // Here we only start the mic (no gesture required) and stop everything on deactivate.
    if (active) {
      startMic();
      startSystemAudio();
      // Don't auto-open sidebar — user can toggle it manually
    } else {
      stopMic();
      stopSystemAudio();
      // FIX #2: Clear interim element when capture stops
      if (interimEl) {
        interimEl.textContent = '';
        interimEl.classList.remove('show');
      }
      // Don't auto-close sidebar — let user keep it open if they want
    }
    if (active && mode === 'local') {
      sttState = 'local';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = 'local'; label.className = 'stt-status stt-local'; }
    } else {
      updateSttStatus({ active, streaming });
    }
  });

  // ---- real-time transcript display (interim + final) ----
  let interimEl = null;
  function getOrCreateInterimEl() {
    if (!interimEl) {
      interimEl = document.createElement('div');
      interimEl.className = 'interim-transcript';
      // Insert into panel-main (the left column), before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(interimEl, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(interimEl);
      } else {
        document.getElementById('panel').appendChild(interimEl);
      }
      interimEl.addEventListener('click', () => {
        const sel = window.getSelection ? window.getSelection().toString().trim() : '';
        if (sel.length > 0) return;
        const textToAsk = interimEl.textContent.replace(/^(Them|You):\s*/i, '').trim();
        if (textToAsk && textToAsk.length >= 2) {
          askHistoryQuestion(textToAsk);
        }
      });
    }
    return interimEl;
  }


  cue.on('stt:interim', ({ channel, text }) => {
    setLiveDotState('transcribing');
    const el = getOrCreateInterimEl();
    const label = channel === 'them' ? 'Them' : 'You';
    el.textContent = `${label}: ${text}`;
    el.classList.add('show');
    appendTranscriptHistoryTurn(channel, text, true); // update sidebar interim
  });
  cue.on('stt:final', ({ channel, text }) => {
    setLiveDotState('idle');
    // Clear interim when we get a final
    if (interimEl) { interimEl.textContent = ''; interimEl.classList.remove('show'); }
    // sidebar: the final turn is added via the 'transcript' event below
  });
  cue.on('stt:status', ({ channel, status, provider }) => {
    cue.log(`[stt] ${provider || channel || 'unknown'} ${status}`);
    if (provider === 'local') {
      const label = document.getElementById('stt-status');
      const localLabels = {
        loading: 'loading local',
        ready: 'local',
        transcribing: 'local',
        stopping: 'stopping',
        off: 'off',
        error: 'error'
      };
      sttState = status === 'ready' || status === 'transcribing' ? 'local' : status;
      if (label) {
        label.textContent = localLabels[status] || status;
        label.className = 'stt-status stt-' + sttState;
      }
      if (status === 'loading') $('#stop-btn').classList.add('active');
      if (status === 'off' || status === 'error') $('#stop-btn').classList.remove('active');
      if (status === 'loading' || status === 'transcribing' || status === 'stopping') setLiveDotState('transcribing');
      if (status === 'ready') setLiveDotState('idle');
      if (status === 'off') setLiveDotState('off');
      return;
    }
    if (status === 'connected') {
      sttState = 'streaming';
      const label = document.getElementById('stt-status');
      if (label) { label.textContent = sttState; label.className = 'stt-status stt-streaming'; }
    }
  });
  cue.on('vad:state', ({ channel, speaking }) => {
    setLiveDotState(speaking ? 'speaking' : 'idle');
  });
  cue.on('llm:start', ({ userBubble, small, category }) => {
    responseCount++;
    if (responseCount > MAX_RESPONSES) {
      const oldest = messages.querySelector('.response-group');
      if (oldest) oldest.remove();
      responseCount = MAX_RESPONSES;
    }
    const group = document.createElement('div');
    group.className = 'response-group';
    const sep = document.createElement('div');
    sep.className = 'response-sep';
    const timeSpan = document.createElement('span');
    timeSpan.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const copyRespBtn = document.createElement('button');
    copyRespBtn.type = 'button';
    copyRespBtn.className = 'resp-copy-btn';
    copyRespBtn.textContent = 'Copy';
    copyRespBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const targetAi = group.querySelector('.ai-text');
      if (!targetAi) return;
      const codeEl = targetAi.querySelector('pre code');
      const raw = rawOf(targetAi);
      const textToCopy = codeEl && raw.includes('```')
        ? (raw || targetAi.innerText || '').trim()
        : (targetAi.innerText || raw || '').trim();
      copyToClipboard(textToCopy, 'Copied response');
      copyRespBtn.textContent = 'Copied ✓';
      setTimeout(() => { copyRespBtn.textContent = 'Copy'; }, 1400);
    });
    sep.appendChild(timeSpan);
    sep.appendChild(copyRespBtn);
    group.appendChild(sep);
    if (userBubble) {
      const b = document.createElement('div');
      b.className = 'user-bubble';
      b.textContent = userBubble;
      group.appendChild(b);
    }
    if (category) {
      const pill = document.createElement('div');
      pill.className = 'category-pill';
      pill.textContent = category.charAt(0).toUpperCase() + category.slice(1);
      group.appendChild(pill);
    }
    group.appendChild(beginAi(small));
    messages.appendChild(group);
    // Use requestAnimationFrame so the DOM is fully updated before scrolling
    requestAnimationFrame(() => {
      if (sep && sep.isConnected) sep.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    setBusy(true);
  });
  cue.on('llm:token', ({ text }) => appendToken(text));
  cue.on('llm:done', () => { finalizeAi(); setBusy(false); });
  cue.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiRaw = message; finalizeAi(); setBusy(false);
  });
  cue.on('transcript', ({ channel, text }) => {
    if (!text || text.trim().length < 2 || /^[?!.,;:\-…]+$/.test(text.trim())) return;
    appendTranscriptHistoryTurn(channel, text, false);
  });

  // ---- Auto-copy on text selection + native Ctrl+C clipboard bridge --------
  // Because the overlay defaults to non-activating (focusable: false) for stealth,
  // Chromium's navigator.clipboard and unfocused Ctrl+C would otherwise fail.
  // Highlighting any text/code inside #messages or #transcript-sidebar automatically
  // copies it to the OS clipboard on mouseup, and Ctrl+C / Cmd+C also copies via IPC.
  document.addEventListener('mouseup', (e) => {
    const t = e.target;
    if (t && t.closest && t.closest('button, input, textarea, select')) return;
    const inCopyableArea = t && t.closest && t.closest('#messages, #transcript-sidebar');
    if (!inCopyableArea) return;
    setTimeout(() => {
      const sel = window.getSelection ? window.getSelection().toString() : '';
      if (sel && sel.trim().length >= 2) {
        copyToClipboard(sel, 'Copied selection');
      }
    }, 15);
  });

  document.addEventListener('copy', (e) => {
    const sel = window.getSelection ? window.getSelection().toString() : '';
    if (sel) {
      e.preventDefault();
      copyToClipboard(sel, 'Copied to clipboard');
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
      const sel = window.getSelection ? window.getSelection().toString() : '';
      if (sel) {
        e.preventDefault();
        copyToClipboard(sel, 'Copied to clipboard');
      }
    }
  });

  // ---- question queue ------------------------------------------------------
  // One shared 4-slot queue: questions cue heard (auto-detected) plus questions
  // the user pre-typed (pinned — detections can't evict them). Click a row (or
  // press its number) to answer it; the pencil drops it into the input box for
  // editing; × dismisses it. The list-plus button in the composer bar forces
  // the strip open even when empty, so questions can be typed ahead of time.
  const qqPanel = document.getElementById('question-queue');
  const qqList = document.getElementById('qq-list');
  const qqHint = document.getElementById('qq-hint');
  const qqToggleBtn = document.getElementById('qq-toggle-btn');
  const qqAddInput = document.getElementById('qq-add-input');
  let questionItems = []; // mirror of main's queue: [{ id, text, pinned }]
  let qqForced = false;   // user toggled the strip open (survives an empty queue)
  if (qqHint) qqHint.textContent = (isMac ? '⌘⌥1–4' : 'Ctrl+Alt+1–4') + ' · click to answer';
  if (qqToggleBtn) qqToggleBtn.innerHTML = icon('list-plus', { size: 15 });

  function renderQuestionQueue() {
    if (!qqPanel || !qqList) return;
    qqList.innerHTML = '';
    if (qqToggleBtn) qqToggleBtn.classList.toggle('active', qqForced);
    // The add box only shows while the toggle is on — the auto-detected view
    // stays exactly as slim as before.
    const addRow = qqPanel.querySelector('.qq-add');
    if (addRow) addRow.classList.toggle('hidden', !qqForced);
    if (!questionItems.length && !qqForced) { qqPanel.classList.add('hidden'); return; }
    qqPanel.classList.remove('hidden');
    questionItems.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'qq-item' + (item.pinned ? ' pinned' : '');

      const key = document.createElement('span');
      key.className = 'keycap';
      key.textContent = String(i + 1);

      const txt = document.createElement('span');
      txt.className = 'qq-text';
      txt.textContent = item.text;

      let pinEl = null;
      if (item.pinned) {
        pinEl = document.createElement('span');
        pinEl.className = 'qq-pin';
        pinEl.innerHTML = icon('pin', { size: 10 });
      }

      const edit = document.createElement('button');
      edit.className = 'qq-act';
      edit.innerHTML = icon('pencil', { size: 12 });
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        input.value = item.text;
        inputFromSTT = false;
        composer.classList.remove('stt-filling', 'stt-dimmed', 'stt-ready', 'stt-accumulating');
        syncPlaceholder();
        updateSendButtonState();
        requestWindowFocus(input);
      });

      const dismiss = document.createElement('button');
      dismiss.className = 'qq-act';
      dismiss.innerHTML = icon('x', { size: 12 });
      dismiss.addEventListener('click', (e) => { e.stopPropagation(); cue.questionDismiss(item.id); });

      row.appendChild(key);
      if (pinEl) row.appendChild(pinEl);
      row.appendChild(txt);
      row.appendChild(edit);
      row.appendChild(dismiss);
      row.addEventListener('click', () => cue.questionAnswer(item.id));
      qqList.appendChild(row);
    });
  }

  cue.on('questions:update', ({ items }) => { questionItems = items || []; renderQuestionQueue(); });

  // Toggle the strip open/closed. Opening focuses the add box so a question
  // can be typed immediately; closing only hides the strip when it's empty
  // (queued questions stay visible — hiding them would orphan the hotkeys).
  if (qqToggleBtn) qqToggleBtn.addEventListener('click', () => {
    qqForced = !qqForced;
    renderQuestionQueue();
    if (qqForced && qqAddInput) requestWindowFocus(qqAddInput);
    else releaseWindowFocusIfIdle();
  });
  if (qqAddInput) {
    qqAddInput.addEventListener('mousedown', () => requestWindowFocus(qqAddInput));
    qqAddInput.addEventListener('blur', () => releaseWindowFocusIfIdle());
  }
  if (qqAddInput) qqAddInput.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep 1-4 answer keys and global handlers out of typing
    if (e.key === 'Escape') { qqAddInput.value = ''; qqAddInput.blur(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = qqAddInput.value.trim();
    if (!text) return;
    cue.questionAdd(text);
    qqAddInput.value = '';
  });
  // Pasting a prepared list (one question per line) queues each line as its
  // own question, first lines first, stopping at the queue's free slots so a
  // long list can't churn out what's already queued.
  if (qqAddInput) qqAddInput.addEventListener('paste', (e) => {
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!text.includes('\n')) return; // single-line paste: normal input behavior
    e.preventDefault();
    const free = Math.max(0, 4 - questionItems.length);
    const lines = text.split('\n')
      .map((s) => s.replace(/^\s*[-*\d.)\s]+/, '').trim()) // strip "- " / "1. " list markers
      .filter(Boolean)
      .slice(0, free);
    for (const line of lines) cue.questionAdd(line);
  });

  // Plain 1-4 answers a queued question while cue has focus and the caret is
  // not in a text field. The global Ctrl/Cmd+Alt+1-4 shortcuts (registered in
  // main) work from anywhere, even when another app has focus.
  document.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key < '1' || e.key > '4') return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('#settings-scrim:not(.hidden), #onboard-scrim:not(.hidden), #consent-scrim:not(.hidden)')) return;
    const item = questionItems[Number(e.key) - 1];
    if (!item) return;
    e.preventDefault();
    cue.questionAnswer(item.id);
  });

  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('cue-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cue-status';
      // Insert into panel-main before the action row
      const panelMain = document.getElementById('panel-main');
      const actionRow = document.getElementById('action-row');
      if (panelMain && actionRow && actionRow.parentNode === panelMain) {
        panelMain.insertBefore(el, actionRow);
      } else if (panelMain) {
        panelMain.appendChild(el);
      } else {
        document.getElementById('panel').appendChild(el);
      }
    }
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  cue.on('status', ({ message }) => {
    cue.log('[status] ' + message);
    showStatus(message);
    if (sttState !== 'disconnected') {
      const lower = message.toLowerCase();
      if (lower.includes('error') || lower.includes(' off')) {
        sttState = 'error';
        const label = document.getElementById('stt-status');
        if (label) { label.textContent = sttState; label.className = 'stt-status stt-error'; }
      }
    }
  });

  // ---- prep status & smart tooltip helpers -------------------------------


  // ---- AI rules: live char counter + soft cap ---------------------------
  function updateAiRulesCounter() {
    const el = document.getElementById('ai-rules');
    const counter = document.getElementById('ai-rules-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const aiRulesEl = document.getElementById('ai-rules');
  if (aiRulesEl) aiRulesEl.addEventListener('input', updateAiRulesCounter);
  // ---- Assist context: live char counter + soft cap ---------------------
  function updateAssistContextCounter() {
    const el = document.getElementById('assist-context');
    const counter = document.getElementById('assist-context-count');
    if (!el || !counter) return;
    const n = el.value.length;
    const cap = 2000;
    counter.textContent = String(n);
    counter.classList.toggle('over', n >= cap);
    counter.parentElement.classList.toggle('s-counter-warn', n >= cap - 100);
  }
  const assistContextEl = document.getElementById('assist-context');
  if (assistContextEl) assistContextEl.addEventListener('input', updateAssistContextCounter);
  // ---- Meeting document: live char counter (soft note, no hard cap) ------
  function updateContextDocCounter() {
    const el = document.getElementById('context-doc');
    const counter = document.getElementById('context-doc-count');
    if (!el || !counter) return;
    const n = el.value.length;
    counter.textContent = n.toLocaleString();
    // Warn when past what actually reaches the AI (8,000 chars)
    counter.parentElement.classList.toggle('s-counter-warn', n > 8000);
  }
  const contextDocEl = document.getElementById('context-doc');
  if (contextDocEl) contextDocEl.addEventListener('input', updateContextDocCounter);
  // ---- Coding instructions: pre-filled with cue's default, editable -------
  // Saving text identical to the default stores '' so the user keeps getting
  // cue's current default instead of a frozen copy of it.
  let codingDefault = '';
  function isCustomCoding(text) {
    const t = (text || '').trim();
    return !!t && t !== codingDefault.trim();
  }
  function updateCodingInstructionsUI() {
    const el = document.getElementById('coding-instructions');
    const counter = document.getElementById('coding-instructions-count');
    const modeEl = document.getElementById('coding-mode');
    if (!el) return;
    const n = el.value.length;
    if (counter) {
      counter.textContent = n.toLocaleString();
      counter.parentElement.classList.toggle('s-counter-warn', n >= 8000 - 200);
    }
    if (modeEl) modeEl.textContent = isCustomCoding(el.value) ? 'Custom instructions' : "Using cue's default";
  }
  const codingEl = document.getElementById('coding-instructions');
  if (codingEl) codingEl.addEventListener('input', updateCodingInstructionsUI);
  const resetCodingBtn = document.getElementById('reset-coding-btn');
  if (resetCodingBtn) resetCodingBtn.addEventListener('click', () => {
    if (!codingEl) return;
    codingEl.value = codingDefault;
    updateCodingInstructionsUI();
    codingEl.focus();
  });
  function updatePrepStatus() {
    if (!settings) return;
    const fields = {
      doc:     !!(settings.contextDoc && settings.contextDoc.trim()),
      resume:  !!(settings.resumeText && settings.resumeText.trim()),
      jd:      !!(settings.jobDescription && settings.jobDescription.trim()),
      stories: !!(settings.starStories && settings.starStories.trim()),
      salary:  !!(settings.salaryTarget && settings.salaryTarget.trim()),
      coding:  isCustomCoding(settings.codingInstructions)
    };
    document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
      const loaded = fields[el.dataset.field];
      el.classList.toggle('loaded', loaded);
      el.classList.toggle('missing', !loaded);
      // The phone chip is always shown as available.
      if (el.dataset.field === 'phone') {
        el.classList.add('loaded');
        el.classList.remove('missing');
      }
    });
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  function openSettings() {
    if (typeof cue.setFocusable === 'function') cue.setFocusable(true);
    fillSettings();
    scrim.classList.remove('hidden');
    refreshWhisperModels();
    refreshPhoneCompanion();
  }
  function closeSettings() {
    saveSettings();
    scrim.classList.add('hidden');
    releaseWindowFocusIfIdle();
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', () => { void closeSettings(); });
  scrim.addEventListener('click', (e) => { if (e.target === scrim) void closeSettings(); });

  // Tab switching
  document.querySelectorAll('.s-tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      if (tab.classList.contains('on')) return;
      if (!(await saveSettings())) return;
      document.querySelectorAll('.s-tab').forEach(t => t.classList.remove('on'));
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.add('hidden'));
      tab.classList.add('on');
      const pane = document.querySelector(`.s-tab-pane[data-pane="${tab.dataset.tab}"]`);
      if (pane) pane.classList.remove('hidden');
      if (tab.dataset.tab === 'phone') refreshPhoneCompanion();
    });
  });

  // Programmatic tab activation (no save needed — used right after openSettings,
  // when fillSettings() has just refreshed every field from saved state).
  function activateSettingsTab(name) {
    document.querySelectorAll('.s-tab').forEach(t => t.classList.toggle('on', t.dataset.tab === name));
    document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== name));
    if (name === 'phone') refreshPhoneCompanion();
  }

  // Prep-status chips (Doc / Resume / JD / Stories / Salary / Phone) jump straight to
  // the settings field that fills them in.
  const PREP_TARGETS = {
    doc:     { tab: 'docs',    field: '#context-doc' },
    resume:  { tab: 'profile', field: '#resume-text' },
    jd:      { tab: 'profile', field: '#job-description' },
    stories: { tab: 'prep',    field: '#star-stories' },
    salary:  { tab: 'qa',      field: '#salary-target' },
    coding:  { tab: 'coding',  field: '#coding-instructions' },
    phone:   { tab: 'phone',   field: '#phone-url-input' }
  };
  document.querySelectorAll('#prep-status .prep-item').forEach((el) => {
    el.addEventListener('click', () => {
      const target = PREP_TARGETS[el.dataset.field];
      if (!target) return;
      openSettings();
      activateSettingsTab(target.tab);
      const field = document.querySelector(target.field);
      if (field) {
        field.scrollIntoView({ block: 'center' });
        field.focus();
      }
    });
  });

  function updateCustomProviderFields() {
    $('#custom-endpoint-settings').classList.toggle('hidden', settings.provider !== 'custom');
  }

  function fillSettings() {
    // Keys tab
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-deepgram').value = settings.apiKeys.deepgram || '';
    $('#key-custom').value = settings.apiKeys.custom || '';
    $('#base-url').value = settings.baseUrl || '';
    updateCustomProviderFields();
    $('#key-ollama').value = settings.apiKeys.ollama || '';
    // Falls back to the default if the saved value is not one of the choices.
    $('#notes-context').value = String(settings.notesContextTokens || 4096);
    if (!$('#notes-context').value) $('#notes-context').value = '4096';
    $('#key-groq').value = settings.apiKeys.groq || '';
    $('#key-minimax').value = settings.apiKeys.minimax || '';
    document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.classList.toggle('on', b.dataset.region === (settings.minimaxRegion || 'global_en')));
    $('#key-azure').value = settings.apiKeys.azure || '';
    $('#azure-endpoint').value = settings.azureEndpoint || '';
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    fillAppLinkCallers();
    $('#s-status').textContent = statusText();
    // Transcription tab
    document.querySelectorAll('#stt-provider-seg button').forEach((button) => {
      button.classList.toggle('on', button.dataset.sttProvider === (settings.sttProvider || 'auto'));
    });
    const localWhisper = settings.localWhisper || { modelId: 'base.en', language: 'auto', threads: 0 };
    $('#whisper-language').value = localWhisper.language || 'auto';
    $('#whisper-threads').value = Number(localWhisper.threads) || 0;
    // Docs tab
    $('#context-doc').value = settings.contextDoc || '';
    updateContextDocCounter();
    // Profile tab
    $('#resume-text').value = settings.resumeText || '';
    $('#job-description').value = settings.jobDescription || '';
    // Interview Prep tab
    $('#star-stories').value = settings.starStories || '';
    $('#why-company').value = settings.whyCompany || '';
    $('#why-leaving').value = settings.whyLeaving || '';
    $('#work-style').value = settings.workStyle || '';
    // Style tab
    $('#ai-rules').value = settings.aiRules || '';    updateAiRulesCounter();
    $('#assist-context').value = settings.assistContext || '';    updateAssistContextCounter();
    // Coding tab
    $('#coding-instructions').value = settings.codingInstructions || codingDefault;
    updateCodingInstructionsUI();
    // Q&A tab
    $('#salary-target').value = settings.salaryTarget || '';
    $('#questions-to-ask').value = settings.questionsToAsk || '';
  }

  // Whoever cue has been told it may answer questions for. Empty is the normal
  // state — nothing appears here until something has asked and been allowed.
  async function fillAppLinkCallers() {
    const host = $('#applink-callers');
    if (!host || !cue.appLinkState) return;
    let state;
    try { state = await cue.appLinkState(); } catch (_) { return; }
    const callers = Object.entries((state && state.callers) || {});
    if (!callers.length) {
      host.innerHTML = '<div class="s-caller-empty">Nothing has asked yet.</div>';
      return;
    }
    host.innerHTML = '';
    for (const [id, scopes] of callers) {
      const allowed = Object.entries(scopes)
        .filter(([, record]) => record && record.decision === 'granted')
        .map(([scope]) => (scope === 'action' ? 'control' : 'read'));
      const name = (scopes.read && scopes.read.callerName) || (scopes.action && scopes.action.callerName) || id;

      const row = document.createElement('div');
      row.className = 's-caller';
      const label = document.createElement('span');
      label.textContent = name + ' — ' + (allowed.length ? allowed.join(' + ') : 'denied');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Forget';
      button.addEventListener('click', async () => {
        await cue.appLinkRevoke(id);
        fillAppLinkCallers();
      });
      row.append(label, button);
      host.append(row);
    }
  }

  const uploadResumeBtn = document.getElementById('upload-resume-btn');
  if (uploadResumeBtn) uploadResumeBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Resume import failed: ' + res.error); return; }
    $('#resume-text').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });
  const uploadDocBtn = document.getElementById('upload-doc-btn');
  if (uploadDocBtn) uploadDocBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Document import failed: ' + res.error); return; }
    $('#context-doc').value = res.text || '';
    updateContextDocCounter();
    const fn = document.getElementById('doc-filename');
    if (fn) fn.textContent = res.fileName || '';
    showStatus('Imported ' + res.fileName + ' — saved when you switch tabs or press Done.');
  });
  const clearDocBtn = document.getElementById('clear-doc-btn');
  if (clearDocBtn) clearDocBtn.addEventListener('click', () => {
    $('#context-doc').value = '';
    updateContextDocCounter();
    const fn = document.getElementById('doc-filename');
    if (fn) fn.textContent = '';
    showStatus('Meeting document cleared — saved when you switch tabs or press Done.');
  });
  const uploadJdBtn = document.getElementById('upload-jd-btn');
  if (uploadJdBtn) uploadJdBtn.addEventListener('click', async () => {
    const res = await cue.pickProfileDocument();
    if (!res || res.canceled) return;
    if (res.error) { showStatus('Job description import failed: ' + res.error); return; }
    $('#job-description').value = res.text || '';
    showStatus('Imported ' + res.fileName + ' — press Save to keep it.');
  });

  function statusText() {
    const k = settings.apiKeys;
    const labels = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini', deepgram: 'Deepgram', custom: 'Custom', ollama: 'Ollama', groq: 'Groq', minimax: 'MiniMax', azure: 'Azure AI Foundry' };
    const has = Object.keys(labels).filter((p) => k[p]).map((p) => labels[p]);
    // 'auto' walks the same fallback chain src/stt.js builds; an explicit choice
    // is reported as-is so the status line matches what will actually be used.
    const selectedSttProvider = settings.sttProvider || 'auto';
    const automaticStt = k.deepgram ? 'Deepgram (streaming)' : (k.openai ? 'OpenAI Realtime' : (k.groq ? 'Groq Whisper' : (k.gemini ? 'Gemini (batch)' : 'none')));
    const stt = selectedSttProvider === 'auto' ? automaticStt : selectedSttProvider;
    const ready = [
      settings.contextDoc ? '✓ doc' : null,
      settings.resumeText ? '✓ resume' : null,
      settings.jobDescription ? '✓ JD' : null,
      settings.starStories ? '✓ stories' : null,
      settings.salaryTarget ? '✓ salary' : null
    ].filter(Boolean);
    return `${labels[settings.provider] || settings.provider} · STT: ${stt}` + (ready.length ? ' · ' + ready.join(' · ') : '');
  }

  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    updateCustomProviderFields();
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  document.querySelectorAll('#minimax-region-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.minimaxRegion = b.dataset.region;
    document.querySelectorAll('#minimax-region-seg button').forEach((x) => x.classList.toggle('on', x === b));
  }));

  document.querySelectorAll('#stt-provider-seg button').forEach((button) => button.addEventListener('click', () => {
    settings.sttProvider = button.dataset.sttProvider;
    document.querySelectorAll('#stt-provider-seg button').forEach((candidate) => {
      candidate.classList.toggle('on', candidate === button);
    });
    $('#s-status').textContent = statusText();
  }));

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    const units = ['B', 'KB', 'MB', 'GB'];
    const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / (1024 ** unitIndex);
    return `${value >= 10 || unitIndex < 2 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function getSelectedWhisperModel() {
    if (!whisperOverview) return null;
    return whisperOverview.models.find((model) => model.id === $('#whisper-model').value) || null;
  }

  function renderWhisperModelState() {
    const model = getSelectedWhisperModel();
    if (!model) return;
    const language = model.englishOnly ? 'English only' : 'Multilingual';
    const recommendation = model.recommended ? ' · recommended default' : '';
    const partial = model.partialBytes > 0 && !model.installed
      ? ` · ${formatBytes(model.partialBytes)} ready to resume`
      : '';
    $('#whisper-model-detail').textContent = `${formatBytes(model.bytes)} · ${language} · ${model.quantization} · ${model.hardwareTier}${recommendation}${partial}`;

    const progressWrap = $('#whisper-progress-wrap');
    const progressPercent = model.bytes > 0 ? Math.floor((model.partialBytes / model.bytes) * 100) : 0;
    progressWrap.classList.toggle('hidden', !model.downloading);
    $('#whisper-progress').value = progressPercent;
    $('#whisper-progress-label').textContent = `${progressPercent}%`;
    $('#whisper-download').disabled = model.installed || model.downloading;
    $('#whisper-download').textContent = model.installed ? 'Installed' : (model.partialBytes ? 'Resume' : 'Download');
    $('#whisper-cancel').classList.toggle('hidden', !model.downloading);
    $('#whisper-import').disabled = model.downloading;
    $('#whisper-delete').disabled = (model.installedBytes === 0 && model.partialBytes === 0) || model.downloading;
  }

  async function refreshWhisperModels() {
    const status = $('#whisper-status');
    try {
      const previousSelection = $('#whisper-model').value || settings.localWhisper?.modelId || 'base.en';
      whisperOverview = await cue.whisperModels();
      const runtimeBadge = $('#whisper-runtime-status');
      runtimeBadge.classList.toggle('ready', whisperOverview.runtime.available);
      runtimeBadge.classList.toggle('error', !whisperOverview.runtime.available);
      runtimeBadge.textContent = whisperOverview.runtime.available
        ? `Ready · v${whisperOverview.runtime.version} · ${whisperOverview.runtime.target}`
        : 'Not prepared';

      const select = $('#whisper-model');
      select.innerHTML = '';
      for (const model of whisperOverview.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.label} — ${formatBytes(model.bytes)}${model.recommended ? ' (recommended)' : ''}${model.installed ? ' ✓' : ''}`;
        select.appendChild(option);
      }
      const selectionExists = whisperOverview.models.some((model) => model.id === previousSelection);
      select.value = selectionExists ? previousSelection : 'base.en';
      if (!settings.localWhisper) settings.localWhisper = {};
      settings.localWhisper.modelId = select.value;
      status.textContent = whisperOverview.runtime.available
        ? 'Model files are verified before they can be loaded.'
        : whisperOverview.runtime.message;
      renderWhisperModelState();
    } catch (error) {
      status.textContent = `Could not load local model information: ${error.message}`;
    }
  }

  $('#whisper-model').addEventListener('change', () => {
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value;
    renderWhisperModelState();
  });

  $('#whisper-download').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    model.downloading = true;
    renderWhisperModelState();
    $('#whisper-status').textContent = `Downloading ${model.id}. You can cancel and resume later.`;
    try {
      await cue.whisperModelDownload(model.id);
      $('#whisper-status').textContent = `${model.id} downloaded and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = error.message.includes('cancelled')
        ? `${model.id} download paused. Progress was kept.`
        : `Download failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  $('#whisper-cancel').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (model) await cue.whisperModelCancel(model.id);
  });

  $('#whisper-import').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    $('#whisper-status').textContent = `Verifying imported ${model.id}…`;
    try {
      const result = await cue.whisperModelImport(model.id);
      $('#whisper-status').textContent = result.cancelled ? 'Import cancelled.' : `${model.id} imported and verified.`;
    } catch (error) {
      $('#whisper-status').textContent = `Import failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  let whisperDeleteArmed = false;
  let whisperDeleteArmTimer = null;
  $('#whisper-delete').addEventListener('click', async () => {
    const model = getSelectedWhisperModel();
    if (!model) return;
    if (!whisperDeleteArmed) {
      whisperDeleteArmed = true;
      $('#whisper-delete').textContent = 'Confirm delete?';
      clearTimeout(whisperDeleteArmTimer);
      whisperDeleteArmTimer = setTimeout(() => {
        whisperDeleteArmed = false;
        $('#whisper-delete').textContent = 'Delete';
      }, 3500);
      return;
    }
    whisperDeleteArmed = false;
    clearTimeout(whisperDeleteArmTimer);
    $('#whisper-delete').textContent = 'Delete';
    try {
      await cue.whisperModelDelete(model.id);
      $('#whisper-status').textContent = `${model.id} deleted.`;
    } catch (error) {
      $('#whisper-status').textContent = `Delete failed: ${error.message}`;
    } finally {
      await refreshWhisperModels();
    }
  });

  cue.on('whisper:download-progress', (progress) => {
    if (!whisperOverview) return;
    const model = whisperOverview.models.find((candidate) => candidate.id === progress.modelId);
    if (!model) return;
    model.partialBytes = progress.receivedBytes;
    model.downloading = true;
    if ($('#whisper-model').value === progress.modelId) {
      $('#whisper-progress-wrap').classList.remove('hidden');
      $('#whisper-progress').value = progress.percent;
      $('#whisper-progress-label').textContent = `${progress.percent}%`;
      $('#whisper-model-detail').textContent = `${formatBytes(progress.receivedBytes)} of ${formatBytes(progress.totalBytes)}`;
    }
  });
  cue.on('whisper:models-changed', () => refreshWhisperModels());

  // ---- Phone Companion settings UI ---------------------------------------
  async function refreshPhoneCompanion() {
    if (typeof cue.phoneInfo !== 'function') return;
    const qrWrap = document.getElementById('phone-qr-wrap');
    const urlInput = document.getElementById('phone-url-input');
    const altUrls = document.getElementById('phone-alt-urls');
    const badge = document.getElementById('phone-conn-badge');
    try {
      const info = await cue.phoneInfo();
      if (!info || !info.running) {
        if (badge) { badge.textContent = 'Offline'; badge.className = 'whisper-badge error'; }
        if (urlInput) urlInput.value = 'Phone server not running';
        return;
      }
      if (qrWrap && info.qrSvg) qrWrap.innerHTML = info.qrSvg;
      if (urlInput) urlInput.value = info.primaryUrl || '';
      if (badge) {
        badge.className = 'whisper-badge ready';
        badge.textContent = info.connectedClients > 0
          ? `${info.connectedClients} phone${info.connectedClients > 1 ? 's' : ''} connected`
          : `Ready · port ${info.port}`;
      }
      if (altUrls) {
        const others = (info.urls || []).filter((u) => u.url !== info.primaryUrl);
        altUrls.textContent = others.length
          ? 'Other LAN interfaces: ' + others.map((u) => `${u.name} (${u.address})`).join(' · ')
          : '';
      }
    } catch (e) {
      if (urlInput) urlInput.value = 'Error: ' + (e && e.message ? e.message : String(e));
    }
  }
  const phoneCopyBtn = document.getElementById('phone-copy-btn');
  if (phoneCopyBtn) {
    phoneCopyBtn.addEventListener('click', () => {
      const urlInput = document.getElementById('phone-url-input');
      if (!urlInput || !urlInput.value) return;
      copyToClipboard(urlInput.value, 'Phone URL copied to clipboard');
    });
  }
  const phoneRefreshBtn = document.getElementById('phone-refresh-btn');
  if (phoneRefreshBtn) phoneRefreshBtn.addEventListener('click', refreshPhoneCompanion);
  const phoneFirewallBtn = document.getElementById('phone-firewall-btn');
  if (phoneFirewallBtn) {
    if (!isWindows) phoneFirewallBtn.classList.add('hidden');
    phoneFirewallBtn.addEventListener('click', async () => {
      if (typeof cue.phoneFirewall !== 'function') return;
      showToast('Approve the Windows Firewall prompt to allow your phone…', 3000);
      const res = await cue.phoneFirewall();
      if (res && res.ok) {
        showToast('Windows Firewall rule added! Try loading the URL on your phone now.', 3500);
      } else {
        showToast('Firewall rule was not added (prompt cancelled).', 3000);
      }
    });
  }
  const phoneRegenBtn = document.getElementById('phone-regen-btn');
  if (phoneRegenBtn) {
    phoneRegenBtn.addEventListener('click', async () => {
      if (typeof cue.phoneRegenerate !== 'function') return;
      await cue.phoneRegenerate();
      await refreshPhoneCompanion();
      showToast('Generated new QR code & disconnected previous sessions', 2200);
    });
  }

  async function saveSettings() {
    // Keys
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.deepgram = $('#key-deepgram').value.trim();
    settings.apiKeys.custom = $('#key-custom').value.trim();
    settings.baseUrl = $('#base-url').value.trim();
    settings.apiKeys.ollama = $('#key-ollama').value.trim();
    settings.notesContextTokens = Number.parseInt($('#notes-context').value, 10) || 4096;
    settings.apiKeys.groq = $('#key-groq').value.trim();
    settings.apiKeys.minimax = $('#key-minimax').value.trim();
    settings.apiKeys.azure = $('#key-azure').value.trim();
    settings.azureEndpoint = $('#azure-endpoint').value.trim();
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    // Transcription
    if (!settings.localWhisper) settings.localWhisper = {};
    settings.localWhisper.modelId = $('#whisper-model').value || settings.localWhisper.modelId || 'base.en';
    settings.localWhisper.language = $('#whisper-language').value || 'auto';
    settings.localWhisper.threads = Math.max(0, Math.min(64, Number.parseInt($('#whisper-threads').value, 10) || 0));
    // Docs
    settings.contextDoc = $('#context-doc').value.trim();
    // Profile
    settings.resumeText = $('#resume-text').value.trim();
    settings.jobDescription = $('#job-description').value.trim();
    // Interview Prep
    settings.starStories = $('#star-stories').value.trim();
    settings.whyCompany = $('#why-company').value.trim();
    settings.whyLeaving = $('#why-leaving').value.trim();
    settings.workStyle = $('#work-style').value.trim();
    // Style tab
    settings.aiRules = $('#ai-rules').value.trim();
    settings.assistContext = $('#assist-context').value.trim();
    // Coding
    const codingText = $('#coding-instructions').value.trim();
    settings.codingInstructions = isCustomCoding(codingText) ? codingText : '';
    // Q&A
    settings.salaryTarget = $('#salary-target').value.trim();
    settings.questionsToAsk = $('#questions-to-ask').value.trim();
    try {
      settings = await cue.settingsSet(settings);
      $('#s-status').textContent = statusText();
      updatePrepStatus();
      return true;
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      $('#s-status').textContent = message;
      $('#base-url').focus();
      return false;
    }
  }

  // ---- example conversation (matches the reference screenshot) ------------
  function showExample() {
    clearMessages();
    addUserBubble('What should I say?');
    const ai = document.createElement('div');
    ai.className = 'ai-text';
    ai.textContent = '';
    messages.appendChild(ai);
  }

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); openSettings(); }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  let ignoring = null;
  let resizeDrag = null; // active resize-grip drag, if any
  let moveDrag = null;   // active toolbar move drag, if any
  let lastMouse = { x: 0, y: 0 };
  function setIgnore(v) { if (v !== ignoring) { ignoring = v; cue.setIgnoreMouse(v); } }
  function isOverInteractiveUI(el) {
    if (!el || !el.closest) return false;
    if (document.body.classList.contains('app-hidden')) return false;
    const appEl = document.getElementById('app');
    if (appEl && appEl.classList.contains('app-hidden')) return false;
    if (el.closest('#toolbar, #settings-scrim, #onboard-scrim, #consent-scrim')) return true;
    const panel = document.getElementById('panel');
    const isCollapsed = panel && panel.classList.contains('collapsed');
    const sidebar = el.closest('#transcript-sidebar');
    if (!isCollapsed && sidebar && !sidebar.classList.contains('hidden')) return true;
    if (panel && !isCollapsed && el.closest('#panel-wrap')) return true;
    return false;
  }
  function syncClickThrough(x, y) {
    if (resizeDrag || moveDrag) return;
    const px = x == null ? lastMouse.x : x;
    const py = y == null ? lastMouse.y : y;
    const el = document.elementFromPoint(px, py);
    setIgnore(!isOverInteractiveUI(el));
  }
  document.addEventListener('mousemove', (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (resizeDrag || moveDrag) return; // window must stay interactive for the whole drag
    syncClickThrough(e.clientX, e.clientY);
  });
  setIgnore(true); // start fully click-through; hovering the panel re-enables it

  // Suppress native OS right-click context menu and native OS [title] tooltips
  // (both spawn separate child HWNDs that are not covered by WDA_EXCLUDEFROMCAPTURE).
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  // Dragging selected text (or a link/icon) starts an OS drag-and-drop: the
  // cursor turns into a drag/no-drop cursor and a ghost image follows it, both
  // drawn by the OS outside this window. Selecting and copying still work.
  window.addEventListener('dragstart', (e) => e.preventDefault());
  function stripNativeTitles(root = document) {
    root.querySelectorAll('[title]').forEach((el) => el.removeAttribute('title'));
  }
  stripNativeTitles();
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes' && m.attributeName === 'title' && m.target) {
        m.target.removeAttribute('title');
      } else if (m.type === 'childList') {
        m.addedNodes.forEach((n) => {
          if (n.nodeType === 1) {
            if (n.hasAttribute && n.hasAttribute('title')) n.removeAttribute('title');
            if (n.querySelectorAll) stripNativeTitles(n);
          }
        });
      }
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['title'], childList: true, subtree: true });

  // ---- toolbar drag: move window via JS without -webkit-app-region: drag ----
  const toolbarEl = document.getElementById('toolbar');
  if (toolbarEl) {
    toolbarEl.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button')) return;
      e.preventDefault();
      e.stopPropagation();
      moveDrag = {
        startX: e.screenX,
        startY: e.screenY,
        winX: window.screenX,
        winY: window.screenY,
        raf: 0
      };
      setIgnore(false);
    });
    document.addEventListener('mousemove', (e) => {
      if (!moveDrag) return;
      if (!(e.buttons & 1)) {
        if (moveDrag.raf) cancelAnimationFrame(moveDrag.raf);
        moveDrag = null;
        return;
      }
      const nx = moveDrag.winX + (e.screenX - moveDrag.startX);
      const ny = moveDrag.winY + (e.screenY - moveDrag.startY);
      if (moveDrag.raf) return;
      moveDrag.raf = requestAnimationFrame(() => {
        if (moveDrag && typeof cue.moveWindow === 'function') {
          moveDrag.raf = 0;
          cue.moveWindow(nx, ny);
        }
      });
    });
    document.addEventListener('mouseup', () => {
      if (!moveDrag) return;
      if (moveDrag.raf) cancelAnimationFrame(moveDrag.raf);
      moveDrag = null;
    });
  }

  // ---- resize grip: drag the panel corner to resize the overlay window ----
  const resizeGrip = document.getElementById('resize-grip');
  if (resizeGrip) {
    resizeGrip.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      resizeDrag = {
        startX: e.screenX,
        startY: e.screenY,
        startW: window.innerWidth,
        startH: window.innerHeight,
        raf: 0
      };
      setIgnore(false);
      document.body.classList.add('resizing');
    });
    document.addEventListener('mousemove', (e) => {
      if (!resizeDrag) return;
      if (!(e.buttons & 1)) { // button released outside the window — end the drag
        if (resizeDrag.raf) cancelAnimationFrame(resizeDrag.raf);
        resizeDrag = null;
        document.body.classList.remove('resizing');
        return;
      }
      const w = resizeDrag.startW + (e.screenX - resizeDrag.startX);
      const h = resizeDrag.startH + (e.screenY - resizeDrag.startY);
      // Throttle to one IPC per frame — mousemove can fire far faster
      if (resizeDrag.raf) return;
      resizeDrag.raf = requestAnimationFrame(() => {
        if (resizeDrag) { resizeDrag.raf = 0; cue.resizeWindow(w, h); }
      });
    });
    document.addEventListener('mouseup', () => {
      if (!resizeDrag) return;
      if (resizeDrag.raf) cancelAnimationFrame(resizeDrag.raf);
      resizeDrag = null;
      document.body.classList.remove('resizing');
    });
  }

  // ---- assistant access request ------------------------------------------
  // Shown here rather than as a native dialog because cue hides its dock icon:
  // an OS panel from an accessory app never comes forward and cannot be
  // clicked. Note the scrim is registered in the click-through selector above
  // and in styles.css — without both, this window stays transparent to the
  // mouse and the buttons do nothing.
  const consentScrim = $('#consent-scrim');
  let pendingConsentId = null;

  function answerConsent(allowed) {
    if (!pendingConsentId) return;
    cue.appLinkConsentRespond(pendingConsentId, allowed);
    pendingConsentId = null;
    consentScrim.classList.add('hidden');
  }

  cue.on('applink:consent-request', (request) => {
    pendingConsentId = request.id;
    $('#cs-title').textContent = request.message;
    $('#cs-body').textContent = request.detail;
    $('#cs-allow').textContent = request.allowLabel;
    consentScrim.classList.remove('hidden');
    // Do not wait for a mousemove to turn the mouse back on: the pointer may
    // already be still, and the sheet would be unclickable until it moved.
    setIgnore(false);
    $('#cs-deny').focus();
  });

  $('#cs-allow').addEventListener('click', () => answerConsent(true));
  $('#cs-deny').addEventListener('click', () => answerConsent(false));
  // Anything other than a deliberate Allow is a no, including Escape and
  // clicking away.
  consentScrim.addEventListener('click', (e) => { if (e.target === consentScrim) answerConsent(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pendingConsentId) { e.preventDefault(); answerConsent(false); }
  });

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  const permissionHelp = isWindows
    ? 'cue needs permission to see and hear. Open Windows Privacy & security settings, allow <strong>Microphone</strong> and <strong>Screen recording</strong> for cue, then come back here.'
    : 'cue needs two macOS permissions. Click each button, turn <strong>cue</strong> ON in the window that opens, then come back here.';
  const permissionButtons = isWindows
    ? [
        { label: 'Open Microphone settings', action: () => cue.openPane('ms-settings:privacy-microphone') },
        { label: 'Open Screen recording settings', action: () => cue.openPane('ms-settings:privacy-screenrecorder') }
      ]
    : [
        { label: 'Open Microphone settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => cue.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ];
  const assistShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">↵</span>' : '<span class="kbd">⌘</span> <span class="kbd">↵</span>';
  const solveShortcut = isWindows ? '<span class="kbd">Ctrl</span> <span class="kbd">H</span>' : '<span class="kbd">⌘</span> <span class="kbd">H</span>';
  const quitShortcut = isWindows ? '<span class="kbd">Ctrl</span><span class="kbd">⇧</span><span class="kbd">X</span>' : '<span class="kbd">⌘</span><span class="kbd">⇧</span><span class="kbd">X</span>';
  const OB_STEPS = [
    {
      title: 'Welcome to cue',
      body: 'cue is a private AI copilot that floats over your screen. It can <strong>see your screen</strong>, <strong>hear your meetings</strong>, and help you answer questions or solve coding problems — while staying hidden from most screen shares.<br><br>This quick guide gets you running in about a minute.'
    },
    {
      title: 'Allow cue to see & hear',
      body: permissionHelp + '<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — to see your screen and hear meeting audio</li></ul>',
      buttons: permissionButtons
    },
    {
      title: 'Connect an AI provider',
      body: 'cue uses <strong>your own</strong> API key — pick <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, <span class="hl">Google Gemini</span>, or <span class="hl">Azure AI Foundry</span>. Get a key from your provider, then paste it into cue\'s Settings.<br><br><strong>Tip:</strong> For the <em>best</em> real-time listening, add a <span class="hl">Deepgram</span> key (lowest latency streaming transcription). Otherwise, an OpenAI key enables streaming via the Realtime API, and Gemini/Whisper work as batch fallbacks.',
      buttons: [{ label: 'Open cue Settings', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      title: 'Stay hidden in Zoom',
      body: 'cue is hidden from most screen shares automatically (Google Meet, Teams, QuickTime — nothing to do). <strong>Zoom needs one setting:</strong><br><br>Zoom → <span class="hl">Settings</span> → <span class="hl">Share Screen</span> → <span class="hl">Advanced</span> → <strong>Screen capture mode</strong> → choose <strong>“Advanced capture with window filtering.”</strong><br><br>Avoid “<strong>without</strong> window filtering” — that mode reveals cue.'
    },
    {
      title: 'You’re all set',
      body: 'How to use cue:<ul><li>' + assistShortcut + ' — <strong>Assist</strong> with whatever\'s on screen or being said</li><li>' + solveShortcut + ' — solve a coding problem on screen</li><li>Click <strong>▢</strong> in the top bar to start listening to a meeting</li><li>Type a question and press <span class="kbd">↵</span></li></ul>Reopen this guide anytime by clicking the <strong>cue logo</strong>. Quit with ' + quitShortcut + '.'
    }
  ];
  let obIndex = 0;
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    $('#ob-icon').innerHTML = icon('logo', { size: 32 });
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    if (settings && !settings.onboarded) { settings.onboarded = true; await cue.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await cue.settingsGet();
    try { codingDefault = (await cue.codingDefault()) || ''; } catch (_) { codingDefault = ''; }
    const platformInfo = await cue.platformInfo();

    // R4: shortcut hints
    const sayHintEl = document.getElementById('say-shortcut-hint');
    const assistHintEl = document.getElementById('assist-shortcut-hint');
    if (sayHintEl) sayHintEl.textContent = isWindows ? 'Ctrl+Shift+↵' : '⌘⇧↵';
    if (assistHintEl) assistHintEl.textContent = isWindows ? 'Ctrl+↵' : '⌘↵';

    // R5: prep status
    updatePrepStatus();
    // Fix 3: Adjust permission buttons based on actual Windows version.
    // ms-settings:privacy-screenrecorder only exists on Windows 11.
    // On Windows 10, screen capture needs no permission — so replace the button
    // with a more helpful note instead of an invalid settings link.
    if (isWindows && platformInfo.winBuild > 0 && platformInfo.winBuild < 22000) {
      // Windows 10: update the onboarding screen recording button to be more helpful
      const ob = OB_STEPS[1];
      ob.buttons = ob.buttons.filter((b) => !b.label.toLowerCase().includes('screen'));
      ob.body = 'cue needs microphone permission to hear you. Click the button below to open Windows microphone settings and allow cue.<br><br><strong>Screen capture works automatically on Windows 10</strong> — no additional permission needed.<ul><li><strong>Microphone</strong> — to hear you</li><li><strong>Screen recording</strong> — works automatically on Windows 10</li></ul>';
    }

    smartBtn.classList.toggle('on', !!settings.smart);
    if (quickBtn) quickBtn.classList.toggle('on', !!settings.quick);
    showExample();
    syncPlaceholder();
    updateHistoryBadge(); // FIX #3: Initialize badge on boot
    updateSendButtonState(); // Initialize send button state

    // Fix placeholder shortcut hint to match platform
    if (isWindows) {
      placeholder.innerHTML = 'Ask about your screen or conversation, or <span class="keycap">Ctrl</span><span class="keycap">⏎</span> for Assist';
    }

    const st = await cue.captureState();
    $('#live-dot').classList.toggle('off', !st.active);
    $('#stop-btn').classList.toggle('active', st.active);
    if (!settings.onboarded) showOnboard();
  })();
})();
