const { app, BrowserWindow, ipcMain, globalShortcut, screen, session, desktopCapturer, shell, dialog, systemPreferences, powerMonitor, clipboard } = require('electron');
const path = require('path');
const os = require('os');
const store = require('./src/store');
const { captureScreenshot } = require('./src/screen');
const { createSTT, looksLikeHallucination, buildVocabPrompt } = require('./src/stt');
const { parseDocumentFile } = require('./src/resume');
const { createLLM } = require('./src/llm');
const { MODES, LEETCODE_DEFAULT_INSTRUCTIONS, QUICK_GOTCHA_SYSTEM, buildQuickTurn } = require('./src/prompts');
const { rms16 } = require('./src/wav');
const { createStreamingSTT } = require('./src/stt-streaming');
const { AdaptiveVAD, AudioRingBuffer } = require('./src/vad');
const { buildInterviewContext, detectCategory } = require('./src/interview-context');
const { createQuestionDetector, normalize: normalizeQuestion } = require('./src/question-detector');
const { createQuestionQueue } = require('./src/question-queue');
const { createChatHistory } = require('./src/chat-history');
const { createTokenCoalescer } = require('./src/token-coalesce');
const {
  LIVE_NOTES_SYSTEM,
  buildLiveNotesPrompt,
  mergeNotesSection,
  countTranscriptWords,
  shouldAutoUpdateNotes
} = require('./src/notes');
const { startAppLink, stopAppLink, recordEvent, appLinkConsentState, revokeAppLinkCaller } = require('./src/applink');

// macOS system-audio loopback (the "them" channel via getDisplayMedia) does not
// start on Electron 31–38 unless these Chromium features are enabled; without
// them getDisplayMedia rejects with "Error starting capture" and meeting audio
// silently never works. Electron 39+ wires this up itself, where this is a
// harmless no-op. Must run before app is ready.
if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
}
const { WhisperModelManager } = require('./src/whisper-model-manager');
const { requireWhisperModel } = require('./src/whisper-model-catalog');
const { locateWhisperRuntime } = require('./src/whisper-runtime');
const { LocalWhisperTranscriber } = require('./src/local-whisper-transcriber');
const { createPhoneCompanionServer } = require('./src/phone-companion');

let win = null;
let phoneCompanion = null;
// Which global shortcuts cue actually holds. `globalShortcut.register` returns
// false when another application already owns the combination, and nothing used
// to look at that — so the only symptom was a key that did nothing. Iris reads
// this and can say which key is taken instead of guessing from a screenshot.
const shortcutState = { assist: false, say: false, leetcode: false, quit: false, focus: false, moveUp: false, moveDown: false, moveLeft: false, moveRight: false, clearChat: false, answerQ1: false, answerQ2: false, answerQ3: false, answerQ4: false };
const isMac = process.platform === 'darwin';
const isWindows = process.platform === 'win32';

// -------- Windows version helpers --------
// WDA_EXCLUDEFROMCAPTURE (setContentProtection) requires Windows 10 build 19041+.
// os.release() returns the NT kernel version e.g. "10.0.19041" or "10.0.22000" (Win11).
function getWindowsBuild() {
  if (!isWindows) return 0;
  const parts = os.release().split('.').map(Number);
  return parts[2] || 0; // third segment is the build number
}
const WIN_BUILD = getWindowsBuild();
const WIN_SUPPORTS_CONTENT_PROTECTION = !isWindows || WIN_BUILD >= 19041;

// True once setContentProtection(true) has been applied to the overlay window.
// On Windows that means WDA_EXCLUDEFROMCAPTURE is active and the compositor
// already drops cue from desktopCapturer output — so screenshots don't need
// the hide → wait 90ms → show dance (or its flicker). macOS exclusion is
// best-effort, so captures there still hide the window to stay safe.
//
// Electron has dropped this flag after hide/show, GPU reset, RDP, and display
// changes, so we re-apply on those events rather than trusting the first call.
let contentProtectionApplied = false;

function contentProtectionWanted() {
  return !process.env.CUE_NO_PROTECT && WIN_SUPPORTS_CONTENT_PROTECTION;
}

function applyContentProtection(targetWin = win) {
  if (!contentProtectionWanted()) {
    contentProtectionApplied = false;
    return false;
  }
  if (!targetWin || targetWin.isDestroyed()) return false;
  try {
    targetWin.setContentProtection(true);
    contentProtectionApplied = true;
    return true;
  } catch (err) {
    contentProtectionApplied = false;
    console.log('[cue] setContentProtection failed:', err && err.message);
    return false;
  }
}

let contentProtectionHooksBound = false;
function bindContentProtectionHooks() {
  if (contentProtectionHooksBound) return;
  contentProtectionHooksBound = true;
  const reapply = () => applyContentProtection(win);
  screen.on('display-added', reapply);
  screen.on('display-removed', reapply);
  screen.on('display-metrics-changed', reapply);
  powerMonitor.on('resume', reapply);
  powerMonitor.on('unlock-screen', reapply);
}

let permWin = null;

// -------- capture / transcript state --------
const state = { capturing: false, busy: false, hidden: false, transcribing: { you: false, them: false } };
let sttDisabled = false; // set when the key can't reach any speech model (stops retry spam)
const buffers = { you: [], them: [] };
const transcript = []; // { channel, text, ts } — capped at MAX_TRANSCRIPT_TURNS
const MAX_TRANSCRIPT_TURNS = 200; // ~30–40 minutes of conversation at normal pace
const FLUSH_MS = 900;
const STREAM_INACTIVITY_MS = 25000; // abort a stalled LLM stream so state.busy can't wedge forever
const LEETCODE_INACTIVITY_MS = 90000; // commented walkthroughs + reasoning can sit silent longer before the first token
const MIN_BYTES = Math.floor(16000 * 2 * 0.12); // ~0.12s
const RMS_GATE = 180;
let flushTimer = null;
let whisperModelManager = null;
let localWhisperTranscriber = null;
let activeWhisperModelId = null;
let desiredCaptureState = false;
let captureTransition = Promise.resolve(false);

// -------- streaming STT state --------
let streamingSTT = { you: null, them: null }; // streaming STT instances per channel
let streamingMode = false; // true when using WebSocket streaming STT
const vad = {
  you: new AdaptiveVAD({
    onsetThreshold: 380,
    offsetThreshold: 200,
    silenceFrames: 16,       // ~480ms silence before end
    minSpeechFrames: 6,
    onSpeechStart: () => send('vad:state', { channel: 'you', speaking: true }),
    onSpeechEnd: (dur) => { send('vad:state', { channel: 'you', speaking: false, durationMs: dur }); flushUtterance('you'); },
    onSpeechCancel: () => send('vad:state', { channel: 'you', speaking: false, durationMs: 0 })
  }),
  them: new AdaptiveVAD({
    onsetThreshold: 200,
    offsetThreshold: 120,
    silenceFrames: 16,       // ~480ms for remote audio
    onSpeechStart: () => send('vad:state', { channel: 'them', speaking: true }),
    onSpeechEnd: (dur) => { send('vad:state', { channel: 'them', speaking: false, durationMs: dur }); flushUtterance('them'); },
    onSpeechCancel: () => send('vad:state', { channel: 'them', speaking: false, durationMs: 0 })
  })
};
// Pre-speech ring buffers (300ms) so we never clip the start of a word
const ringBuffers = {
  you: new AudioRingBuffer(300, 16000),
  them: new AudioRingBuffer(300, 16000)
};

// -------- detected-question queue --------
// Interviewer questions extracted from "them" turns, shown as a small queue in
// the renderer. Each slot maps to a hotkey (Ctrl/Cmd+Alt+1..4) that answers it
// directly via the answerThis mode — no typing needed. Detection is pure local
// regex work (see src/question-detector.js), so it adds no latency anywhere.
const QUESTION_QUEUE_MAX = 4;
const QUESTION_SILENCE_FLUSH_MS = 2500;
const questionDetector = createQuestionDetector();
// Shared 4-slot queue: auto-detected questions + questions the user pre-typed
// (pinned — a background detection can never evict one). Policy + tests live
// in src/question-queue.js.
const questionQueue = createQuestionQueue({ max: QUESTION_QUEUE_MAX, normalize: normalizeQuestion });
let questionFlushTimer = null;

function sendQuestionQueue() {
  send('questions:update', { items: questionQueue.items() });
}

function addDetectedQuestions(found) {
  if (!found || !found.length) return;
  let changed = false;
  for (const text of found) changed = questionQueue.addDetected(text) || changed;
  if (changed) sendQuestionQueue();
}

function handleThemUtterance(text, ts) {
  addDetectedQuestions(questionDetector.push(text, ts));
  // After a quiet gap, classify a trailing fragment that never got terminal
  // punctuation (e.g. "walk me through your resume" with no "?").
  clearTimeout(questionFlushTimer);
  questionFlushTimer = setTimeout(() => addDetectedQuestions(questionDetector.flushPending()), QUESTION_SILENCE_FLUSH_MS);
}

function clearQuestionQueue() {
  clearTimeout(questionFlushTimer);
  questionDetector.reset();
  if (questionQueue.clear()) sendQuestionQueue();
}

// Answer the question in slot `index` (0-based). Removing it before answering
// keeps the queue stable for the next hotkey press.
function answerDetectedQuestion(index) {
  if (state.busy) {
    send('status', { message: 'Still answering the previous question — try again in a moment.' });
    return;
  }
  const item = questionQueue.takeAt(index);
  if (!item) return;
  sendQuestionQueue();
  runFeature('answerThis', item.text);
}

const notesState = {
  modeActive: false,
  busy: false,
  markdown: '',
  lastTurnIndex: 0,
  updatedAt: null,
  engineLabel: 'Local Ollama / Free LLM'
};

function getNotesPublicState() {
  const pendingSlice = transcript.slice(notesState.lastTurnIndex);
  const pendingTurns = pendingSlice.length;
  const pendingWords = countTranscriptWords(pendingSlice);
  return {
    modeActive: notesState.modeActive,
    busy: notesState.busy,
    markdown: notesState.markdown,
    lastTurnIndex: notesState.lastTurnIndex,
    totalTurns: transcript.length,
    pendingTurns,
    pendingWords,
    autoShouldUpdate: shouldAutoUpdateNotes({
      modeActive: notesState.modeActive,
      busy: notesState.busy,
      pendingTurns,
      pendingWords
    }),
    updatedAt: notesState.updatedAt,
    engineLabel: notesState.engineLabel
  };
}

function pushTranscript(turn) {
  transcript.push(turn);
  if (transcript.length > MAX_TRANSCRIPT_TURNS) {
    const removed = transcript.length - MAX_TRANSCRIPT_TURNS;
    transcript.splice(0, removed);
    notesState.lastTurnIndex = Math.max(0, notesState.lastTurnIndex - removed);
  }
  if (turn.channel === 'them' && !notesState.modeActive) handleThemUtterance(turn.text, turn.ts);
  send('notes:state', getNotesPublicState());
}

function send(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
  if (phoneCompanion) phoneCompanion.broadcast(channel, data);
}

function getWhisperRuntime() {
  return locateWhisperRuntime({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    platform: process.platform,
    architecture: process.arch,
    environment: process.env
  });
}

function publishTranscript(channel, text) {
  if (!text || !text.trim() || looksLikeHallucination(text)) return;
  const turn = { channel, text: text.trim(), ts: Date.now() };
  pushTranscript(turn);
  send('transcript', turn);
  send('stt:final', { channel, text: turn.text });
}

async function startLocalWhisper(settings) {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const localSettings = settings.localWhisper || {};
  const model = requireWhisperModel(localSettings.modelId || 'base.en');
  const runtime = getWhisperRuntime();
  if (!runtime.available) throw new Error(runtime.message);
  activeWhisperModelId = model.id;
  let transcriber = null;
  try {
    const modelPath = await whisperModelManager.verifyInstalledModel(model.id).catch((error) => {
      if (error.code === 'ENOENT') {
        throw new Error(`Download the ${model.id} model in Settings → Audio before listening.`);
      }
      throw error;
    });

    transcriber = new LocalWhisperTranscriber({
      sessionOptions: {
        executablePath: runtime.executablePath,
        runtimeDirectory: runtime.runtimeDirectory,
        modelPath,
        language: model.englishOnly ? 'en' : (localSettings.language || 'auto'),
        threads: Number(localSettings.threads) || 0,
        tinydiarize: model.tinydiarize,
        prompt: buildVocabPrompt(settings)
      },
      onTranscript: publishTranscript,
      onSpeechState: (channel, speaking, durationMs) => {
        send('vad:state', { channel, speaking, durationMs });
      },
      onStatus: (status) => send('stt:status', { provider: 'local', ...status }),
      onError: (error) => {
        sttDisabled = true;
        console.log('[local-whisper] error', error && error.message);
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription error: ${error.message}. Audio was not sent to a cloud fallback.` });
      }
    });

    localWhisperTranscriber = transcriber;
    await transcriber.start();
  } catch (error) {
    if (localWhisperTranscriber === transcriber) localWhisperTranscriber = null;
    activeWhisperModelId = null;
    if (transcriber) await transcriber.forceStop().catch(() => {});
    throw error;
  }
}

async function getWhisperOverview() {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const runtime = getWhisperRuntime();
  const models = await whisperModelManager.listModels();
  return {
    runtime: {
      available: runtime.available,
      version: runtime.version,
      target: runtime.target,
      message: runtime.message || null
    },
    models
  };
}

// -------- window --------
const MIN_WIN_W = 460;
const MIN_WIN_H = 360;
const ZOOM_MIN = 0.75;
const ZOOM_MAX = 1.75;
const ZOOM_STEP = 0.1;

function bumpZoom(dir) {
  if (!win || win.isDestroyed()) return;
  const wc = win.webContents;
  if (dir === 0) {
    wc.setZoomFactor(1);
    return;
  }
  const next = Math.round((wc.getZoomFactor() + dir * ZOOM_STEP) * 20) / 20;
  wc.setZoomFactor(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();

  const savedSettings = store.getSettings();
  // Restore the user's chosen size, clamped to the current work area.
  const W = Math.max(MIN_WIN_W, Math.min(Number(savedSettings.windowW) || 700, workArea.width));
  const H = Math.max(MIN_WIN_H, Math.min(Number(savedSettings.windowH) || 600, workArea.height));
  let startX = Math.round(workArea.x + (workArea.width - W) / 2);
  let startY = workArea.y + 6;

  if (savedSettings.windowX !== null && savedSettings.windowY !== null) {
    const clampedX = Math.max(workArea.x - W + 100, Math.min(savedSettings.windowX, workArea.x + workArea.width - 100));
    const clampedY = Math.max(workArea.y, Math.min(savedSettings.windowY, workArea.y + workArea.height - 40));
    startX = clampedX;
    startY = clampedY;
  }

  const winOptions = {
    width: W,
    height: H,
    x: startX,
    y: startY,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  };

  // Fix 1: On Windows, set type:'toolbar' which sets WS_EX_TOOLWINDOW.
  // This removes the window from Alt+Tab AND the taskbar entirely.
  // On macOS, this is not needed (dock hiding + Mission Control handle it).
  if (isWindows) {
    winOptions.type = 'toolbar';
  }

  win = new BrowserWindow(winOptions);

  // Fix 2: Only call setContentProtection if the OS supports it.
  // On Windows, WDA_EXCLUDEFROMCAPTURE requires build 19041+ (Windows 10 May 2020 Update).
  // On older builds we skip it silently to avoid a no-op and send a warning to the renderer.
  // Re-apply after show/restore — hide/show and GPU/display changes can drop the flag.
  const shouldProtect = !process.env.CUE_NO_PROTECT;
  applyContentProtection(win);
  bindContentProtectionHooks();
  win.on('show', () => applyContentProtection(win));
  win.on('restore', () => applyContentProtection(win));
  if (shouldProtect && isWindows && !WIN_SUPPORTS_CONTENT_PROTECTION) {
    console.log(`[cue] Windows build ${WIN_BUILD} < 19041 — setContentProtection not supported. Window may appear in screen shares.`);
  }

  win.setAlwaysOnTop(true, 'screen-saver', 1);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (isMac && typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Chromium binds zoom-out to Ctrl+- but zoom-in to Ctrl+= (not Ctrl+Shift+= /
  // the + key). Users hit Ctrl++ and nothing happens. Handle all the plus
  // variants here so zoom is symmetric.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    if (!(input.control || input.meta)) return;
    const key = input.key;
    const code = input.code;
    // Ctrl+= (no shift) and Ctrl+Shift+= / Ctrl++ / numpad + all zoom in.
    const zoomIn = key === '+' || key === '=' || key === 'Add' || code === 'NumpadAdd';
    const zoomOut = key === '-' || key === '_' || key === 'Subtract' || code === 'NumpadSubtract';
    const zoomReset = key === '0' && !input.shift;
    if (zoomIn) { event.preventDefault(); bumpZoom(1); }
    else if (zoomOut) { event.preventDefault(); bumpZoom(-1); }
    else if (zoomReset) { event.preventDefault(); bumpZoom(0); }
  });

  let moveSaveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [x, y] = win.getPosition();
        store.setSettings({ windowX: x, windowY: y });
      }
    }, 500);
  });

  let resizeSaveTimer = null;
  win.on('resize', () => {
    clearTimeout(resizeSaveTimer);
    resizeSaveTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) {
        const [w, h] = win.getSize();
        store.setSettings({ windowW: w, windowH: h });
      }
    }, 500);
  });

  win.setTitle('Microsoft Edge Update'); // set before load
  win.on('page-title-updated', (e) => e.preventDefault());

  win.webContents.on('did-finish-load', () => {
    win.showInactive();
    win.setTitle('Microsoft Edge Update');
    applyContentProtection(win);
    // Warn about missing content protection on old Windows builds
    if (isWindows && shouldProtect && !WIN_SUPPORTS_CONTENT_PROTECTION) {
      send('status', {
        message: `Heads up: your Windows version (build ${WIN_BUILD}) does not support screen-share hiding. Upgrade to Windows 10 build 19041+ or Windows 11 to enable invisibility in screen shares.`
      });
    }
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[cue] renderer gone', JSON.stringify(d));
    recordEvent({ level: 'fatal', event: 'renderer_gone', code: d && d.reason, msg: 'renderer process ended: ' + JSON.stringify(d), frame: 'BrowserWindow' });
  });
}

// -------- STT flushing (batch mode fallback) --------
async function flushChannel(channel) {
  if (state.transcribing[channel]) return;
  const chunks = buffers[channel];
  if (!chunks.length) return;
  const pcm = Buffer.concat(chunks);
  buffers[channel] = [];
  if (pcm.length < MIN_BYTES) return;
  if (rms16(pcm) < RMS_GATE) return; // silence gate

  state.transcribing[channel] = true;
  try {
    const settings = store.getSettings();
    const stt = createSTT(settings);
    if (!stt.available) {
      if (!sttDisabled) { sttDisabled = true; send('status', { message: 'No transcription key set. Add an OpenAI (Whisper), Deepgram, or Gemini key in Settings to enable listening. Screen/LeetCode features work without it.' }); }
      return;
    }
    const res = await stt.transcribe(pcm);
    if (res.error) {
      handleSttError(res.error, settings);
      return;
    }
    if (res.text && res.text.trim() && res.text.trim().length > 1 && !/^[?!.,;:\-…]+$/.test(res.text.trim())) {
      const turn = { channel, text: res.text.trim(), ts: Date.now() };
      pushTranscript(turn);
      send('transcript', turn);
    }
  } catch (e) {
    console.log('[stt] error', e && e.message);
    recordEvent({ level: 'error', event: 'stt_failed', msg: e && e.message ? e.message : String(e), frame: 'flushChannel', context: { channel } });
  } finally {
    state.transcribing[channel] = false;
  }
}

function handleSttError(err, settings) {
  console.log('[stt] error', err.provider, err.status, err.code, err.message);
  // Recorded before the early return, because the second and hundredth
  // occurrence still tell you the state cue is stuck in.
  recordEvent({
    level: 'error',
    event: 'stt_rejected',
    code: err.code || (err.status ? 'http_' + err.status : null),
    msg: err.message,
    frame: 'handleSttError',
    context: { provider: err.provider, status: err.status || null, alreadyDisabled: sttDisabled },
  });
  if (sttDisabled) return;
  const isQuota = err.status === 429 || err.code === 'RESOURCE_EXHAUSTED' || (err.message && err.message.includes('Quota exceeded'));
  const noAccess = err.status === 403 || err.status === 401 || err.code === 'model_not_found' || isQuota;
  sttDisabled = true; // stop hammering the API every few seconds
  if (noAccess) {
    send('status', { message: `Transcription off: your ${err.provider} key was rejected or hit a quota limit. Update your key in Settings to resume.` });
  } else {
    send('status', { message: 'Transcription error (' + err.provider + '): ' + err.message });
  }
}

// Batch mode used to slice audio into fixed 900ms chunks, which hands Whisper
// arbitrary mid-word fragments. Now the VAD's speech-end event flushes one
// COMPLETE utterance (accuracy: the model sees a whole thought with context),
// and the timer below is a safety net: it flushes quiet leftovers the VAD
// never classified as speech, and force-flushes a non-stop talker at the cap
// so latency and memory stay bounded.
const MAX_BATCH_BUFFER_BYTES = 16000 * 2 * 12; // ~12s of continuous speech

function flushUtterance(channel) {
  if (!state.capturing || streamingMode || localWhisperTranscriber) return;
  flushChannel(channel);
}

function timedFlush(channel) {
  let buffered = 0;
  for (const chunk of buffers[channel]) buffered += chunk.length;
  if (!buffered) return;
  if (vad[channel].getState().isSpeaking && buffered < MAX_BATCH_BUFFER_BYTES) return;
  flushChannel(channel);
}

function startFlushLoop() {
  if (flushTimer) return;
  flushTimer = setInterval(() => { timedFlush('you'); timedFlush('them'); }, FLUSH_MS);
}
function stopFlushLoop() { if (flushTimer) { clearInterval(flushTimer); flushTimer = null; } }

// -------- streaming STT setup --------
function initStreamingSTT() {
  const settings = store.getSettings();
  streamingMode = false;

  ['you', 'them'].forEach((channel) => {
    const sttInstance = createStreamingSTT(settings, channel, {
      onTranscript: (ch, text) => {
        const turn = { channel: ch, text, ts: Date.now() };
        pushTranscript(turn);
        send('transcript', turn);
        send('stt:final', { channel: ch, text });
      },
      onInterim: (ch, text) => {
        send('stt:interim', { channel: ch, text });
      },
      onError: (err) => {
        console.log('[streaming-stt] error', err.provider, err.message);
        const batchFallbackAvailable = createSTT(settings).available;
        stopStreamingSTT(); // close WebSockets and clear keep-alive intervals
        if (batchFallbackAvailable) {
          send('status', { message: `Streaming transcription (${err.provider}) error: ${err.message}. Falling back to batch mode.` });
          startFlushLoop();
        } else if (!sttDisabled) {
          sttDisabled = true;
          send('status', { message: `Transcription stopped (${err.provider}): ${err.message}. The selected provider has no batch fallback.` });
        }
        streamingMode = false;
      },
      onStatusChange: (ch, status) => {
        send('stt:status', { channel: ch, status });
        if (status === 'connected') {
          console.log(`[streaming-stt] ${ch} channel connected`);
        }
      }
    });

    if (sttInstance.type === 'streaming' && sttInstance.instance) {
      streamingMode = true;
      streamingSTT[channel] = sttInstance.instance;
      sttInstance.instance.connect();
    }
  });

  return streamingMode;
}

function stopStreamingSTT() {
  ['you', 'them'].forEach((channel) => {
    if (streamingSTT[channel]) {
      streamingSTT[channel].disconnect();
      streamingSTT[channel] = null;
    }
  });
  streamingMode = false;
}

// -------- audio routing (streaming or batch) --------
function routeAudio(channel, pcmBuffer) {
  const buf = Buffer.from(pcmBuffer);

  if (localWhisperTranscriber) {
    localWhisperTranscriber.push(channel, buf);
    return;
  }

  // Always run through VAD for speech state detection
  vad[channel].processChunk(buf);

  // Keep pre-speech buffer
  ringBuffers[channel].write(buf);

  if (streamingMode && streamingSTT[channel]) {
    // Streaming mode: send raw PCM directly to the WebSocket
    streamingSTT[channel].sendAudio(pcmBuffer);
  } else {
    // Batch mode: accumulate in buffers for periodic flush
    buffers[channel].push(buf);
  }
}

// -------- capture toggle --------
// Mic + system audio are both captured in the RENDERER (getUserMedia for the mic,
// getDisplayMedia loopback for system audio) so they run inside cue's own process
// and use cue's own Screen-Recording grant — no separate helper binary to authorize.
async function setCapturing(active) {
  if (active === state.capturing) return state.capturing;

  if (active) {
    sttDisabled = false; // reset on re-enable
    const settings = store.getSettings();
    if ((settings.sttProvider || 'auto') === 'local') {
      try {
        await startLocalWhisper(settings);
        state.capturing = true;
        console.log('[cue] capture started, mode: local');
        send('capture:state', { active: true, streaming: false, mode: 'local' });
        return true;
      } catch (error) {
        state.capturing = false;
        desiredCaptureState = false;
        if (error.code === 'STARTUP_CANCELLED') {
          send('stt:status', { provider: 'local', status: 'off' });
          send('capture:state', { active: false, streaming: false, mode: 'local' });
          return false;
        }
        send('stt:status', { provider: 'local', status: 'error' });
        send('status', { message: `Local transcription could not start: ${error.message} No audio was sent to a cloud provider.` });
        send('capture:state', { active: false, streaming: false, mode: 'local' });
        return false;
      }
    }

    state.capturing = true;
    // Try streaming first, fall back to batch
    const streaming = initStreamingSTT();
    if (!streaming) {
      startFlushLoop();
    }
    console.log('[cue] capture started, mode:', streaming ? 'streaming' : 'batch');
    send('capture:state', { active: true, streaming: streamingMode, mode: streaming ? 'streaming' : 'batch' });
    return true;
  }

  state.capturing = false;
  stopFlushLoop();
  stopStreamingSTT();
  buffers.you = []; buffers.them = [];
  vad.you.reset(); vad.them.reset();
  ringBuffers.you.clear(); ringBuffers.them.clear();
  // Surface a question that was asked right before listening stopped.
  clearTimeout(questionFlushTimer);
  addDetectedQuestions(questionDetector.flushPending());
  const stoppingLocalTranscriber = localWhisperTranscriber;
  localWhisperTranscriber = null;
  send('capture:state', { active: false, streaming: false, mode: stoppingLocalTranscriber ? 'local' : 'off' });
  if (stoppingLocalTranscriber) {
    send('stt:status', { provider: 'local', status: 'stopping' });
    try {
      await stoppingLocalTranscriber.stop();
    } catch (error) {
      console.log('[local-whisper] stop error', error && error.message);
    } finally {
      activeWhisperModelId = null;
    }
  }
  return false;
}

// -------- chat memory for typed follow-ups --------
// Every completed answer is recorded (text-only, bounded, 10-minute TTL).
// Typed questions (`ask`) and the Follow-up button consume it so they can
// stay on the same topic as the last answer. Assist/LeetCode/queue answers
// stay stateless fresh-look actions.
const chatHistory = createChatHistory();

// How a non-typed feature appears as the "user side" of a recorded exchange,
// so a later follow-up can tell what the assistant was responding to.
const HISTORY_LABELS = {
  assist: '(Assist — analyze my current screen and conversation)',
  say: '(What should I say next?)',
  followup: '(Suggest follow-up questions to ask)',
  recap: '(Recap the conversation so far)',
  leetcode: '(Solve the coding problem on my screen)'
};

// -------- feature runner --------
async function runFeature(mode, userText) {
  if (state.busy) return;
  const def = MODES[mode];
  if (!def) return;
  state.busy = true;
  let streamSettled = false; // drop stray tokens from a stream we've already abandoned
  try {
    const settings = store.getSettings();
    const llm = createLLM(settings);
    const userBubble = def.userBubble !== null
      ? def.userBubble
      : (mode === 'ask' ? userText : mode === 'answerThis' ? `"${(userText || '').slice(0, 60)}${userText && userText.length > 60 ? '…' : ''}"` : null);
    const category = mode !== 'leetcode' ? detectCategory(transcript, userText) : null;
    send('llm:start', { userBubble, small: !!def.small, category });

    if (!llm.ready) {
      const message = llm.configurationError || ('Complete the ' + settings.provider + ' provider settings. Model: ' + (llm.model || 'unset') + '.');
      send('llm:error', { message });
      return;
    }

    // Open the TCP+TLS connection to the provider now, in parallel with the
    // screenshot below — by the time the request goes out, the socket is warm.
    llm.warmup();

    const isQuickMode = !!settings.quick && (mode === 'ask' || mode === 'say' || mode === 'assist' || mode === 'answerThis');
    const isRecallOrSynthesis = /synthesis|synthesize|recommendation|conclusion|recap|summary|summarize|entire case|whole case|all findings|from (the )?beginning|earlier|previous|first question|what did (we|you) (say|calculate)/i.test(userText || '');
    const isShortFollowup = /^(make (that|it) shorter|shorter\b|explain that|what does that mean|give me an example|more detail)/i.test((userText || '').trim());
    // Quick mode keeps the last 2 exchanges (small, capped by chat-history truncation)
    // so follow-ups like "what about the IA?" resolve against the prior answer.
    const priorTurns = isQuickMode
      ? chatHistory.recent().slice(isShortFollowup ? -2 : -4)
      : ((mode === 'ask' || mode === 'followup' || mode === 'answerThis' || mode === 'say')
          ? (isRecallOrSynthesis ? chatHistory.all() : chatHistory.recent())
          : []);

    // Skip screen capture for typed `ask` prompts that don't reference the screen/code
    // (e.g. "What is NTLM relay?", "Tell me about a time...", "Make that shorter")
    // and for `say` when live transcript has recent interviewer speech that doesn't ask to look at the screen.
    // In Quick mode, skip screen capture whenever there is a typed question or any spoken transcript.
    const referencesScreen = !userText || !userText.trim()
      || /\b(screen|screenshot|slide|diagram|code|line|function|class|method|bug|error|exception|warning|output|terminal|console|image|chart|table|graph|window|page|browser|editor|ide|shown|visible|display|above|below|look at|read this|solve this|fix this|what is this|on screen|hackerrank|leetcode)\b/i.test(userText);
    const skipScreenForTextAsk = mode === 'ask' && !referencesScreen;
    const recentThemTurn = mode === 'say'
      && transcript.length > 0
      && transcript.slice(-3).some(t => t.channel === 'them' && t.text && t.text.trim().length > 12 && !/\b(screen|slide|diagram|code|line|chart|table|shown|look at|here)\b/i.test(t.text));
    const skipScreenForQuick = isQuickMode && ((userText && userText.trim().length > 0) || transcript.length > 0);

    const needsScreenNow = def.needsScreen && !skipScreenForTextAsk && !recentThemTurn && !skipScreenForQuick;

    // Kick off screen capture asynchronously so context & prompt assembly run in parallel
    const screenshotPromise = needsScreenNow
      ? (async () => {
          try {
            applyContentProtection(win);
            const dataUrl = await captureScreenshot(win, { skipHide: (isWindows && contentProtectionApplied) || state.hidden });
            if (!dataUrl) throw new Error('No screen source was available.');
            return dataUrl;
          } catch (e) {
            recordEvent({ level: 'error', event: 'screen_capture_failed', msg: e && e.message ? e.message : String(e), frame: 'captureScreenshot', context: { mode } });
            const message = process.platform === 'darwin'
              ? 'Screen capture needs permission — grant Screen Recording to cue in System Settings.'
              : process.platform === 'win32'
                ? 'Screen capture failed. Make sure cue is not blocked by Windows privacy or security software, then try again.'
                : 'Screen capture failed. Check your desktop capture permissions, then try again.';
            send('status', { message });
            return null;
          } finally {
            applyContentProtection(win);
          }
        })()
      : Promise.resolve(null);

    // Assemble interview context and prompt while screenshot is in flight
    const contextBlock = isQuickMode ? null : buildInterviewContext(settings, mode, transcript, userText, category);
    const system = isQuickMode
      ? QUICK_GOTCHA_SYSTEM
      : (def.buildSystem ? def.buildSystem(contextBlock, settings.aiRules || '', settings) : (def.system || ''));
    const built = isQuickMode
      ? buildQuickTurn({ transcript, userText: userText || '' })
      : def.build({ transcript, userText: userText || '', chatHistory: chatHistory.all() });
    const imageDataUrl = await screenshotPromise;

    // Watchdog: a provider that stalls mid-stream would otherwise hang the await forever,
    // leaving state.busy = true and wedging every later question until an app restart.
    let watchdog = null;
    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('the model stopped responding (timed out). Please try again.')), mode === 'leetcode' ? LEETCODE_INACTIVITY_MS : STREAM_INACTIVITY_MS);
      };
      rearm();
    });

    let fullText = '';
    let firstTokenEmitted = false;
    const tokens = createTokenCoalescer((t) => {
      if (streamSettled) return;
      rearm();
      send('llm:token', { text: t });
    });
    try {
      fullText = await Promise.race([
        llm.stream({
          system,
          turns: [...priorTurns, { role: 'user', text: built }],
          imageDataUrl,
          mode,
          onToken: (t) => {
            if (streamSettled) return;
            tokens.push(t);
            // Flush the very first token immediately (0ms delay) for instant TTFT,
            // then coalesce subsequent streaming deltas at 60fps.
            if (!firstTokenEmitted) {
              firstTokenEmitted = true;
              tokens.flush();
            }
          },
          // Thought summaries and overload retries aren't visible text, but
          // they prove the provider is working — don't count them as a stall.
          onActivity: () => { if (!streamSettled) rearm(); }
        }),
        stalled
      ]);
    } finally {
      tokens.flush();
      streamSettled = true;
      clearTimeout(watchdog);
    }
    // Only successful answers become memory — an error or stall records nothing.
    const historyUserText = (mode === 'ask' || mode === 'answerThis')
      ? (userText || '')
      : (HISTORY_LABELS[mode] || mode);
    chatHistory.record(historyUserText, typeof fullText === 'string' ? fullText : '');
    send('llm:done', {});
  } catch (e) {
    recordEvent({ level: 'error', event: 'llm_failed', msg: e && e.message ? e.message : String(e), frame: 'runFeature', context: { mode, provider: store.getSettings().provider } });
    send('llm:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    state.busy = false;
  }
}

// -------- Live Notetaking (Free Local Ollama / Delta Notes) --------
const PREFERRED_OLLAMA_MODELS = [
  'qwen2.5:7b',
  'qwen2.5:3b',
  'llama3.1:8b',
  'llama3.2:3b',
  'llama3.2',
  'llama3.1',
  'qwen2.5',
  'gemma2',
  'mistral'
];

async function probeLocalOllamaModel(settings) {
  const baseUrl = ((settings.apiKeys && settings.apiKeys.ollama) || 'http://localhost:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(900) });
    if (!res.ok) return null;
    const data = await res.json();
    const installed = Array.isArray(data && data.models)
      ? data.models.map((m) => m && m.name).filter((n) => typeof n === 'string' && !/embed/i.test(n))
      : [];
    if (!installed.length) return { running: true, model: null, baseUrl };

    const configuredFast = settings.models && settings.models.ollama && settings.models.ollama.fast;
    if (configuredFast) {
      const exactOrTag = installed.find((n) => n === configuredFast || n === `${configuredFast}:latest` || n.startsWith(`${configuredFast}:`));
      if (exactOrTag) return { running: true, model: exactOrTag, baseUrl };
    }
    for (const pref of PREFERRED_OLLAMA_MODELS) {
      const match = installed.find((n) => n === pref || n === `${pref}:latest` || n.startsWith(`${pref}:`));
      if (match) return { running: true, model: match, baseUrl };
    }
    return { running: true, model: installed[0], baseUrl };
  } catch (_) {
    return null;
  }
}

function preloadLocalOllamaModel(baseUrl, model) {
  if (!baseUrl || !model) return;
  fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [],
      keep_alive: '30m',
      options: { num_ctx: 2048 }
    })
  }).catch(() => {});
}

async function resolveNotesLLM(settings) {
  // Notes Mode uses 100% Free Local Ollama exclusively (never consumes cloud API keys)
  const ollamaProbe = await probeLocalOllamaModel(settings);
  if (ollamaProbe && ollamaProbe.model) {
    const ollamaSettings = {
      provider: 'ollama',
      smart: false,
      quick: false,
      apiKeys: { ollama: ollamaProbe.baseUrl },
      models: {
        ollama: { fast: ollamaProbe.model, smart: ollamaProbe.model }
      }
    };
    return {
      llm: createLLM(ollamaSettings),
      label: `Ollama · ${ollamaProbe.model} (Free Local)`,
      isLocal: true,
      ready: true,
      ollamaBaseUrl: ollamaProbe.baseUrl,
      ollamaModel: ollamaProbe.model
    };
  }

  if (ollamaProbe && ollamaProbe.running) {
    return {
      llm: { ready: false },
      label: 'Ollama (No model — run `ollama pull qwen2.5:7b`)',
      isLocal: true,
      ready: false,
      error: 'Ollama is running, but no local model was found. Run: ollama pull qwen2.5:7b'
    };
  }

  return {
    llm: { ready: false },
    label: 'Ollama offline (Free Local LLM)',
    isLocal: true,
    ready: false,
    error: 'Local Ollama is offline. Start the Ollama application on your PC to generate free notes.'
  };
}

function hasSubstantiveSpeech(turns) {
  if (!Array.isArray(turns) || turns.length === 0) return false;
  const text = turns.map((t) => (t && t.text ? t.text : '')).join(' ').trim();
  const words = text.split(/\s+/).filter(Boolean);
  return words.length >= 6;
}

async function runNotesUpdate(opts = {}) {
  if (notesState.busy) return;
  const task = opts.task || 'update';
  const isAuto = !!opts.auto;
  if (typeof opts.currentNotes === 'string') {
    notesState.markdown = opts.currentNotes.trim();
  }
  if (!transcript.length && !notesState.markdown) {
    if (!isAuto) send('notes:error', { message: 'Type some notes or capture speech first.' });
    return;
  }

  notesState.busy = true;
  send('notes:state', getNotesPublicState());

  let streamSettled = false;
  let watchdog = null;
  const abortCtrl = new AbortController();
  try {
    const settings = store.getSettings();
    const notesLLM = await resolveNotesLLM(settings);
    notesState.engineLabel = notesLLM.label;

    if (!notesLLM.ready || !notesLLM.llm || !notesLLM.llm.ready) {
      if (!isAuto) {
        send('notes:error', {
          message: notesLLM.error || 'Local Ollama is offline. Start Ollama to generate free notes without using your API quota.'
        });
      }
      return;
    }
    const { llm, label } = notesLLM;

    const forceFull = !!opts.forceFull;
    const turnSnapshotCount = transcript.length;
    const isDelta = !forceFull && !!notesState.markdown && turnSnapshotCount > notesState.lastTurnIndex;
    const deltaCount = isDelta ? (turnSnapshotCount - notesState.lastTurnIndex) : turnSnapshotCount;

    if (task === 'update' && notesState.markdown && transcript.length > 0 && turnSnapshotCount <= notesState.lastTurnIndex && !forceFull) {
      if (!isAuto) send('notes:error', { message: 'No new speech since last update.' });
      return;
    }

    if (task === 'update' && isDelta) {
      const newTurns = transcript.slice(notesState.lastTurnIndex);
      if (!hasSubstantiveSpeech(newTurns)) {
        if (!isAuto) send('notes:error', { message: 'Not enough new speech since last update.' });
        return;
      }
    }

    const timeLabel = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const promptText = buildLiveNotesPrompt({
      transcript: transcript.slice(0, turnSnapshotCount),
      previousNotes: forceFull ? '' : notesState.markdown,
      lastTurnIndex: forceFull ? 0 : notesState.lastTurnIndex,
      task,
      timeLabel
    });

    send('notes:start', {
      engineLabel: label,
      isDelta,
      isAuto,
      totalTurns: turnSnapshotCount,
      deltaTurns: deltaCount,
      task,
      timeLabel
    });

    let rearm = () => {};
    const stalled = new Promise((_res, reject) => {
      rearm = () => {
        clearTimeout(watchdog);
        watchdog = setTimeout(() => reject(new Error('Notes generation timed out. Please try again.')), 75000);
      };
      rearm();
    });

    let fullText = '';
    let firstTokenEmitted = false;
    const tokens = createTokenCoalescer((t) => {
      if (streamSettled) return;
      rearm();
      send('notes:token', { text: t });
    });

    try {
      fullText = await Promise.race([
        llm.stream({
          system: LIVE_NOTES_SYSTEM,
          turns: [{ role: 'user', text: promptText }],
          imageDataUrl: null,
          mode: 'recap',
          maxTokens: 900,
          signal: abortCtrl.signal,
          onToken: (t) => {
            if (streamSettled) return;
            tokens.push(t);
            if (!firstTokenEmitted) {
              firstTokenEmitted = true;
              tokens.flush();
            }
          },
          onActivity: () => { if (!streamSettled) rearm(); }
        }),
        stalled
      ]);
    } finally {
      tokens.flush();
      streamSettled = true;
      clearTimeout(watchdog);
      abortCtrl.abort();
    }

    if (typeof fullText === 'string' && fullText.trim()) {
      const merged = mergeNotesSection(notesState.markdown, fullText.trim(), task, isDelta);
      if (merged === notesState.markdown && notesState.markdown.length > 0) {
        if (task === 'update') {
          notesState.lastTurnIndex = turnSnapshotCount;
        }
        if (!isAuto) {
          send('notes:error', {
            message: task === 'questions'
              ? 'No new questions — topics already covered in prior questions.'
              : 'No new points — already captured in previous updates.'
          });
        }
      } else {
        notesState.markdown = merged;
        if (task === 'update') {
          notesState.lastTurnIndex = turnSnapshotCount;
        }
        notesState.updatedAt = Date.now();
      }
    }
    send('notes:done', getNotesPublicState());
  } catch (e) {
    if (!isAuto) send('notes:error', { message: e && e.message ? e.message : String(e) });
  } finally {
    streamSettled = true;
    clearTimeout(watchdog);
    abortCtrl.abort();
    notesState.busy = false;
    send('notes:state', getNotesPublicState());
  }
}

// -------- IPC --------
function buildPhonePrepSnapshot(s) {
  return {
    resumeText: s.resumeText || '',
    jobDescription: s.jobDescription || '',
    starStories: s.starStories || '',
    whyCompany: s.whyCompany || '',
    whyLeaving: s.whyLeaving || '',
    salaryTarget: s.salaryTarget || '',
    questionsToAsk: s.questionsToAsk || '',
    contextDoc: s.contextDoc || ''
  };
}

function toggleCapture() {
  const targetState = !desiredCaptureState;
  desiredCaptureState = targetState;
  if (!targetState && !state.capturing && localWhisperTranscriber) {
    localWhisperTranscriber.forceStop().catch(() => {});
  }
  captureTransition = captureTransition
    .catch(() => state.capturing)
    .then(() => setCapturing(targetState));
  return captureTransition;
}

ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('prompts:coding-default', () => LEETCODE_DEFAULT_INSTRUCTIONS);
ipcMain.handle('settings:set', (_e, patch) => {
  sttDisabled = false;
  const updated = store.setSettings(patch);
  if (phoneCompanion) {
    phoneCompanion.broadcast('smart:state', { smart: !!updated.smart });
    phoneCompanion.broadcast('quick:state', { quick: !!updated.quick });
    phoneCompanion.broadcast('prep:update', { prep: buildPhonePrepSnapshot(updated) });
  }
  return updated;
});
ipcMain.handle('capture:toggle', () => toggleCapture());
ipcMain.handle('capture:state', () => ({ active: state.capturing }));
ipcMain.handle('phone:info', () => (phoneCompanion ? phoneCompanion.getInfo() : null));
ipcMain.handle('phone:regenerate', () => (phoneCompanion ? phoneCompanion.regenerateToken() : null));
ipcMain.on('clipboard:write', (_e, text) => {
  try { clipboard.writeText(String(text || '')); } catch (_) {}
});
ipcMain.handle('clipboard:read', () => {
  try { return clipboard.readText(); } catch (_) { return ''; }
});
ipcMain.handle('phone:firewall', async () => {
  if (!isWindows) return { ok: true };
  const info = phoneCompanion ? phoneCompanion.getInfo() : null;
  const targetPort = (info && info.port) || 47832;
  const { execFile } = require('child_process');
  return new Promise((resolve) => {
    const cmd = `Start-Process netsh -ArgumentList 'advfirewall firewall add rule name="Cue Phone Companion" dir=in action=allow protocol=TCP localport=${targetPort} profile=any remoteip=localsubnet' -Verb RunAs -Wait`;
    execFile('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], (err) => {
      resolve({ ok: !err, error: err ? err.message : null });
    });
  });
});
ipcMain.on('hide:state', (_e, hidden) => {
  state.hidden = !!hidden;
  if (phoneCompanion) phoneCompanion.broadcast('hide:state', { hidden: state.hidden });
});
ipcMain.handle('whisper:models', () => getWhisperOverview());
ipcMain.handle('whisper:model-download', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  const result = await whisperModelManager.download(modelId, (progress) => send('whisper:download-progress', progress));
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-cancel', (_event, modelId) => {
  if (!whisperModelManager) return false;
  return whisperModelManager.cancelDownload(modelId);
});
ipcMain.handle('whisper:model-delete', async (_event, modelId) => {
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before deleting the active model.');
  }
  const result = await whisperModelManager.deleteModel(modelId);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('whisper:model-import', async (_event, modelId) => {
  if (!whisperModelManager) throw new Error('The local Whisper model manager is not ready.');
  requireWhisperModel(modelId);
  if (activeWhisperModelId === modelId) {
    throw new Error('Stop listening before replacing the active model.');
  }
  const selection = await dialog.showOpenDialog(win, {
    title: `Import ggml-${modelId}.bin`,
    properties: ['openFile'],
    filters: [{ name: 'whisper.cpp model', extensions: ['bin'] }]
  });
  if (selection.canceled || !selection.filePaths[0]) return { cancelled: true };
  const result = await whisperModelManager.importModel(modelId, selection.filePaths[0]);
  send('whisper:models-changed', { modelId });
  return result;
});
ipcMain.handle('platform:info', () => ({
  platform: process.platform,
  winBuild: WIN_BUILD,
  winSupportsContentProtection: WIN_SUPPORTS_CONTENT_PROTECTION
}));
ipcMain.handle('transcript:clear', () => {
  transcript.splice(0, transcript.length);
  notesState.lastTurnIndex = 0;
  clearQuestionQueue();
  chatHistory.clear();
  send('notes:state', getNotesPublicState());
  if (phoneCompanion) phoneCompanion.broadcast('chat:clear', {});
  return { ok: true };
});
ipcMain.handle('notes:mode', async (_e, active) => {
  notesState.modeActive = !!active;
  if (notesState.modeActive) {
    // Probe local Ollama right when entering Notes mode so the badge shows the active engine
    // and pre-warm the model into VRAM so the first click starts streaming immediately.
    try {
      const { label, ollamaBaseUrl, ollamaModel } = await resolveNotesLLM(store.getSettings());
      notesState.engineLabel = label;
      if (ollamaBaseUrl && ollamaModel) {
        preloadLocalOllamaModel(ollamaBaseUrl, ollamaModel);
      }
    } catch (_) {}
  }
  const pub = getNotesPublicState();
  send('notes:state', pub);
  return pub;
});
ipcMain.handle('notes:state', () => getNotesPublicState());
ipcMain.handle('notes:clear', () => {
  notesState.markdown = '';
  notesState.lastTurnIndex = transcript.length;
  notesState.updatedAt = null;
  const pub = getNotesPublicState();
  send('notes:state', pub);
  return pub;
});
ipcMain.on('notes:generate', (_e, opts) => {
  runNotesUpdate(opts || {});
});
ipcMain.on('notes:edit', (_e, markdown) => {
  if (typeof markdown === 'string') {
    notesState.markdown = markdown;
  }
});
ipcMain.on('questions:answer', (_e, id) => {
  const index = questionQueue.indexOf(id);
  if (index !== -1) answerDetectedQuestion(index);
});
ipcMain.on('questions:dismiss', (_e, id) => {
  if (questionQueue.removeById(id)) sendQuestionQueue();
});
// User pre-typed a question into the queue. Pinned: auto-detections can never
// evict it; it leaves only by being answered, dismissed, or a newer pinned add.
ipcMain.on('questions:add', (_e, text) => {
  if (questionQueue.addPinned(typeof text === 'string' ? text : '')) sendQuestionQueue();
});
ipcMain.on('ask', (_e, payload) => runFeature(payload.mode, payload.text));
// Renderer signals intent (e.g. first keystroke in the ask box): pre-open the
// provider connection so TLS is done before the user presses Enter. Deduped
// inside llm.js, so keystroke spam costs nothing.
ipcMain.on('llm:warm', () => {
  try { createLLM(store.getSettings()).warmup(); } catch (_) { /* best-effort */ }
});
ipcMain.on('mic:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('you', arrayBuffer); });
ipcMain.on('system:pcm', (_e, arrayBuffer) => { if (state.capturing) routeAudio('them', arrayBuffer); });
ipcMain.on('mouse:ignore', (_e, v) => { if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(!!v, { forward: true }); });
// On-demand focusable toggle: keeps the overlay non-activating (WS_EX_NOACTIVATE)
// during button clicks and scrolling so browser assessments / IDEs never fire
// window.onblur, and only enables focus when typing in an input box.
let currentWinFocusable = false;
ipcMain.on('win:focusable', (_e, payload) => {
  if (!win || win.isDestroyed()) return;
  const want = typeof payload === 'object' && payload !== null ? !!payload.focusable : !!payload;
  const activate = typeof payload === 'object' && payload !== null ? !!payload.activate : want;
  try {
    if (want !== currentWinFocusable) {
      currentWinFocusable = want;
      win.setFocusable(want);
      if (!want) {
        win.blur();
      }
    }
    if (want && activate) {
      if (!win.isFocused()) win.focus();
      if (win.webContents && !win.webContents.isFocused()) {
        win.webContents.focus();
      }
    }
  } catch (_) {}
});
ipcMain.on('win:move', (_e, pos) => {
  if (!win || win.isDestroyed() || !pos) return;
  const x = Math.round(Number(pos.x));
  const y = Math.round(Number(pos.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  win.setPosition(x, y);
});
// Resize driven by the renderer's drag grip. Clamped to a sane minimum and to
// the work area of whichever display the window currently sits on.
ipcMain.on('win:resize', (_e, size) => {
  if (!win || win.isDestroyed() || !size) return;
  const bounds = win.getBounds();
  const { workArea } = screen.getDisplayMatching(bounds);
  const w = Math.round(Math.max(MIN_WIN_W, Math.min(Number(size.width) || 0, workArea.width)));
  const h = Math.round(Math.max(MIN_WIN_H, Math.min(Number(size.height) || 0, workArea.height)));
  if (w === bounds.width && h === bounds.height) return;
  win.setResizable(true);
  win.setBounds({ x: bounds.x, y: bounds.y, width: w, height: h });
  win.setResizable(false);
  applyContentProtection(win);
});
ipcMain.on('open-pane', (_e, url) => { shell.openExternal(url).catch(() => {}); });
ipcMain.on('app:quit', () => app.quit());
ipcMain.on('log', (_e, msg) => console.log('[renderer]', msg));
// -------- resume / job-description file import --------
// The dialog runs in MAIN and is filtered to pdf/docx; the renderer never supplies a path.
// The parsed text is RETURNED to the renderer, which drops it into the existing
// #resume-text / #job-description textareas so settings keep a single source of truth.
async function pickAndParseDocument() {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Documents (PDF, DOCX, HTML, TXT, MD)', extensions: ['pdf', 'docx', 'html', 'htm', 'txt', 'md'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  const filePath = res.filePaths[0];
  const text = await parseDocumentFile(filePath);
  return { fileName: path.basename(filePath), text };
}
ipcMain.handle('profile:pickDocument', async () => {
  try {
    const picked = await pickAndParseDocument();
    if (!picked) return { canceled: true };
    return { canceled: false, fileName: picked.fileName, text: picked.text };
  } catch (e) {
    return { canceled: false, error: (e && e.message) || String(e) };
  }
});
ipcMain.handle('applink:state', () => appLinkConsentState());
ipcMain.handle('applink:revoke', (_e, callerId) => revokeAppLinkCaller(callerId));

// -------- permissions IPC --------
ipcMain.handle('permissions:check', () => getPermissionStatus());
ipcMain.handle('permissions:request', () => requestPermissions());
ipcMain.on('permissions:continue', async () => {
  const status = await getPermissionStatus();
  if (status.mic === 'granted' && status.screen === 'granted') {
    if (permWin) { permWin.close(); permWin = null; }
    launchApp();
  }
});

// -------- shortcuts --------
function registerShortcuts() {
  shortcutState.assist = globalShortcut.register('CommandOrControl+Return', () => runFeature('assist', ''));
  shortcutState.say = globalShortcut.register('CommandOrControl+Shift+Return', () => runFeature('say', ''));
  shortcutState.leetcode = globalShortcut.register('CommandOrControl+H', () => runFeature('leetcode', ''));
  shortcutState.hide = globalShortcut.register('CommandOrControl+Shift+/', () => send('hide:toggle', {}));
  try { globalShortcut.register('CommandOrControl+\\', () => send('hide:toggle', {})); } catch (_) {}
  shortcutState.focus = globalShortcut.register('CommandOrControl+Shift+Space', () => {
    if (win && !win.isDestroyed()) {
      try { win.setFocusable(true); } catch (_) {}
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      applyContentProtection(win);
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      send('focus:input', {});
    }
  });
  // Nudge the panel with the keyboard instead of dragging it. 40px per press.
  const STEP = 40;
  const moveWindow = (dx, dy) => {
    if (!win || win.isDestroyed()) return;
    const [x, y] = win.getPosition();
    win.setPosition(x + dx, y + dy);
  };
  shortcutState.moveUp = globalShortcut.register('CommandOrControl+Alt+Shift+Up', () => moveWindow(0, -STEP));
  shortcutState.moveDown = globalShortcut.register('CommandOrControl+Alt+Shift+Down', () => moveWindow(0, STEP));
  shortcutState.moveLeft = globalShortcut.register('CommandOrControl+Alt+Shift+Left', () => moveWindow(-STEP, 0));
  shortcutState.moveRight = globalShortcut.register('CommandOrControl+Alt+Shift+Right', () => moveWindow(STEP, 0));
  shortcutState.clearChat = globalShortcut.register('CommandOrControl+Shift+Backspace', () => {
    chatHistory.clear(); // wiping the visible chat also wipes the model's follow-up memory
    send('chat:clear', {});
  });
  // Answer detected question 1-4 from anywhere. Ctrl/Cmd+Alt avoids browser tab
  // switching (Ctrl+1..4) and the macOS screenshot keys (Cmd+Shift+3/4).
  for (let slot = 0; slot < 4; slot++) {
    shortcutState['answerQ' + (slot + 1)] = globalShortcut.register(
      `CommandOrControl+Alt+${slot + 1}`,
      () => answerDetectedQuestion(slot)
    );
  }
  shortcutState.quit = globalShortcut.register('CommandOrControl+Shift+X', () => app.quit());
  for (const [name, wasRegistered] of Object.entries(shortcutState)) {
    if (!wasRegistered) {
      recordEvent({ level: 'warn', event: 'shortcut_unavailable', msg: 'another application holds the ' + name + ' shortcut', frame: 'registerShortcuts', context: { shortcut: name } });
    }
  }
}

// -------- permissions --------
// systemPreferences.getMediaAccessStatus('screen') is unreliable: it can return
// 'not-determined' or 'denied' even after the user has granted Screen Recording,
// especially in dev mode (unsigned / no proper app bundle).  As a fallback we
// actually attempt a capture and inspect the thumbnail — if it contains any
// non-zero pixel data, macOS is giving us real screen content, i.e. granted.
async function verifyScreenAccess() {
  const sysStatus = systemPreferences.getMediaAccessStatus('screen');
  if (sysStatus === 'granted') return 'granted';

  // Fallback: try an actual capture and check the thumbnail for real pixels.
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 16, height: 16 },
    });
    if (sources.length > 0) {
      const bmp = sources[0].thumbnail.toBitmap();
      // toBitmap() returns raw RGBA bytes; any non-zero byte means real content
      if (bmp && bmp.some(byte => byte !== 0)) return 'granted';
    }
  } catch (_) {}

  return sysStatus;  // return the original system status if fallback didn't help
}

async function getPermissionStatus() {
  if (process.platform !== 'darwin') return { mic: 'granted', screen: 'granted' };
  return {
    mic: systemPreferences.getMediaAccessStatus('microphone'),
    screen: await verifyScreenAccess(),
  };
}

async function requestPermissions() {
  if (process.platform !== 'darwin') return true;

  // Trigger the macOS microphone permission dialog (first-use only)
  const micStatus = systemPreferences.getMediaAccessStatus('microphone');
  if (micStatus !== 'granted') {
    await systemPreferences.askForMediaAccess('microphone');
  }

  // Trigger the macOS screen-recording permission dialog (first-use only).
  // There is no askForMediaAccess('screen'), but attempting to enumerate
  // sources via desktopCapturer will cause macOS to prompt the user.
  const screenStatus = await verifyScreenAccess();
  if (screenStatus !== 'granted') {
    try { await desktopCapturer.getSources({ types: ['screen'] }); } catch (_) {}
  }

  const status = await getPermissionStatus();
  return status.mic === 'granted' && status.screen === 'granted';
}

function createPermissionsWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const W = 500, H = 540;
  permWin = new BrowserWindow({
    width: W,
    height: H,
    x: Math.round(workArea.x + (workArea.width - W) / 2),
    y: Math.round(workArea.y + (workArea.height - H) / 2),
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    skipTaskbar: false,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });
  permWin.loadFile(path.join(__dirname, 'renderer', 'permissions.html'));
  permWin.webContents.on('did-finish-load', () => permWin.show());
}

// -------- launch (called after permissions are confirmed) --------
function launchApp() {
  if (isMac && app.dock) app.dock.hide();

  whisperModelManager = new WhisperModelManager({ userDataPath: app.getPath('userData') });

  const allowMedia = (permission) => permission === 'media' || permission === 'microphone' || permission === 'audioCapture' || permission === 'display-capture' || permission === 'screen';
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowMedia(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));

  // System-audio loopback for getDisplayMedia: hand back a screen source with 'loopback'
  // audio so the renderer can capture what's playing (Zoom/Meet) using cue's own grant.
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources.length) return callback();
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => callback());
  }, { useSystemPicker: false });

  // Started before the shortcuts so their registration failures are recorded.
  startAppLink({
    snapshot: () => ({
      state,
      transcript,
      settings: store.getSettings(),
      sttDisabled,
      shortcuts: { ...shortcutState },
      windowAlive: !!(win && !win.isDestroyed()),
    }),
    setCapturing,
    // Looked up rather than captured: the window is recreated on 'activate',
    // so a reference taken at startup goes stale.
    getWindow: () => win,
  });

  createWindow();
  registerShortcuts();

  // Start local LAN Phone Companion server (token-gated HTTP + WebSocket)
  const initialSettings = store.getSettings();
  phoneCompanion = createPhoneCompanionServer({
    port: 47832,
    initialToken: initialSettings.phoneToken || '',
    onTokenChange: (newToken) => store.setSettings({ phoneToken: newToken }),
    getSnapshot: () => {
      const s = store.getSettings();
      const rawTurns = chatHistory.all();
      const exchanges = [];
      for (let i = 0; i < rawTurns.length; i += 2) {
        if (rawTurns[i] && rawTurns[i + 1]) {
          exchanges.push({ user: rawTurns[i].text, assistant: rawTurns[i + 1].text });
        }
      }
      return {
        capturing: state.capturing,
        hidden: state.hidden,
        smart: !!s.smart,
        quick: !!s.quick,
        questions: questionQueue.items(),
        transcript: transcript.slice(-80),
        exchanges: exchanges.slice(-15),
        prep: buildPhonePrepSnapshot(s)
      };
    },
    onAction: (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const act = msg.action || msg.type;
      switch (act) {
        case 'capture:toggle':
          toggleCapture();
          break;
        case 'hide:toggle':
          send('hide:toggle', {});
          break;
        case 'smart:toggle': {
          const cur = store.getSettings();
          const nextSmart = !cur.smart;
          const updated = store.setSettings({ smart: nextSmart, quick: nextSmart ? false : cur.quick });
          send('smart:state', { smart: !!updated.smart });
          send('quick:state', { quick: !!updated.quick });
          break;
        }
        case 'quick:toggle': {
          const cur = store.getSettings();
          const nextQuick = !cur.quick;
          const updated = store.setSettings({ quick: nextQuick, smart: nextQuick ? false : cur.smart });
          send('quick:state', { quick: !!updated.quick });
          send('smart:state', { smart: !!updated.smart });
          break;
        }
        case 'chat:clear':
          transcript.splice(0, transcript.length);
          clearQuestionQueue();
          chatHistory.clear();
          send('chat:clear', {});
          break;
        case 'question:add':
          if (questionQueue.addPinned(typeof msg.text === 'string' ? msg.text : '')) sendQuestionQueue();
          break;
        case 'question:dismiss':
          if (questionQueue.removeById(msg.id)) sendQuestionQueue();
          break;
        case 'question:answer': {
          const idx = questionQueue.indexOf(msg.id);
          if (idx !== -1) answerDetectedQuestion(idx);
          break;
        }
        case 'ask':
          runFeature(msg.mode || 'ask', msg.text || '');
          break;
        default:
          break;
      }
    }
  });
  phoneCompanion.start().then((info) => {
    if (info && info.token && info.token !== store.getSettings().phoneToken) {
      store.setSettings({ phoneToken: info.token });
    }
  }).catch((err) => {
    console.log('[phone-companion] failed to start:', err && err.message);
  });

  // Load the provider SDKs while cue is idle, off the critical path — otherwise
  // the very first ask pays their module-load cost (~100–200ms) before the
  // request can even start. Deferred so it never competes with window startup.
  setTimeout(() => {
    for (const mod of ['openai', '@anthropic-ai/sdk', '@google/genai']) {
      try { require(mod); } catch (_) { /* optional at runtime */ }
    }
    // Same idle window: open the TLS socket so the first Assist isn't a handshake.
    try { createLLM(store.getSettings()).warmup(); } catch (_) { /* best-effort */ }
  }, 1500);
}

// -------- lifecycle --------
app.whenReady().then(async () => {
  app.setName('MicrosoftEdgeUpdate');
  if (isWindows) {
    process.title = 'MicrosoftEdgeUpdate';
  }

  if (isMac) {
    const allGranted = await requestPermissions();
    if (!allGranted) {
      // Show the permissions gate — the dock stays visible so the user can find the app
      createPermissionsWindow();
      app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createPermissionsWindow(); });
      return;
    }
  }

  launchApp();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  // Best effort, deliberately not blocking the quit: the library also removes
  // the instance file from a `process.on('exit')` handler, and a file left
  // behind is harmless anyway because readers check whether the PID is alive.
  // Delaying shutdown to tidy a directory would be the wrong trade.
  stopAppLink();
  if (phoneCompanion) phoneCompanion.stop().catch(() => {});
  if (whisperModelManager?.activeDownload) {
    whisperModelManager.cancelDownload(whisperModelManager.activeDownload.modelId);
  }
  if (localWhisperTranscriber) localWhisperTranscriber.forceStop().catch(() => {});
});
app.on('window-all-closed', () => app.quit());

app.on('will-quit', () => { globalShortcut.unregisterAll(); });
app.on('window-all-closed', (e) => {
  // Don't quit while the permissions window is open — the user may be in System Settings
  if (permWin) { e.preventDefault(); return; }
  app.quit();
});
