const { contextBridge, ipcRenderer, clipboard } = require('electron');
const platform = process.platform;

contextBridge.exposeInMainWorld('cue', {
  platform,
  copyText: (text) => {
    const str = String(text || '');
    try { clipboard.writeText(str); } catch (_) {}
    ipcRenderer.send('clipboard:write', str);
  },
  readClipboard: () => {
    try { return clipboard.readText(); } catch (_) { return ''; }
  },
  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  codingDefault: () => ipcRenderer.invoke('prompts:coding-default'),
  whisperModels: () => ipcRenderer.invoke('whisper:models'),
  whisperModelDownload: (modelId) => ipcRenderer.invoke('whisper:model-download', modelId),
  whisperModelCancel: (modelId) => ipcRenderer.invoke('whisper:model-cancel', modelId),
  whisperModelDelete: (modelId) => ipcRenderer.invoke('whisper:model-delete', modelId),
  whisperModelImport: (modelId) => ipcRenderer.invoke('whisper:model-import', modelId),
  platformInfo: () => ipcRenderer.invoke('platform:info'),
  ask: (payload) => ipcRenderer.send('ask', payload),
  warm: () => ipcRenderer.send('llm:warm'),
  questionAnswer: (id) => ipcRenderer.send('questions:answer', id),
  questionDismiss: (id) => ipcRenderer.send('questions:dismiss', id),
  questionAdd: (text) => ipcRenderer.send('questions:add', text),
  captureToggle: () => ipcRenderer.invoke('capture:toggle').catch((err) => {
    console.error('[cue] captureToggle error', err);
    return false;
  }),
  captureState: () => ipcRenderer.invoke('capture:state'),
  micPcm: (arrayBuffer) => ipcRenderer.send('mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('mouse:ignore', v),
  setFocusable: (v) => ipcRenderer.send('win:focusable', typeof v === 'object' && v !== null ? v : !!v),
  moveWindow: (x, y) => ipcRenderer.send('win:move', { x, y }),
  setHiddenState: (hidden) => ipcRenderer.send('hide:state', !!hidden),
  phoneInfo: () => ipcRenderer.invoke('phone:info'),
  phoneRegenerate: () => ipcRenderer.invoke('phone:regenerate'),
  phoneFirewall: () => ipcRenderer.invoke('phone:firewall'),
  resizeWindow: (width, height) => ipcRenderer.send('win:resize', { width, height }),
  clearTranscript: () => ipcRenderer.invoke('transcript:clear'),
  notesModeSet: (active) => ipcRenderer.invoke('notes:mode', !!active),
  notesGenerate: (opts) => ipcRenderer.send('notes:generate', opts || {}),
  notesEdit: (markdown) => ipcRenderer.send('notes:edit', String(markdown || '')),
  notesClear: () => ipcRenderer.invoke('notes:clear'),
  notesState: () => ipcRenderer.invoke('notes:state'),
  openPane: (url) => ipcRenderer.send('open-pane', url),
  appLinkState: () => ipcRenderer.invoke('applink:state'),
  appLinkRevoke: (callerId) => ipcRenderer.invoke('applink:revoke', callerId),
  appLinkConsentRespond: (id, allowed) => ipcRenderer.send('applink:consent-response', { id, allowed }),
  pickProfileDocument: () => ipcRenderer.invoke('profile:pickDocument'),
  quit: () => ipcRenderer.send('app:quit'),
  permissionsCheck: () => ipcRenderer.invoke('permissions:check'),
  permissionsRequest: () => ipcRenderer.invoke('permissions:request'),
  permissionsContinue: () => ipcRenderer.send('permissions:continue'),
  log: (msg) => ipcRenderer.send('log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'notes:start', 'notes:token', 'notes:done', 'notes:error', 'notes:state', 'status', 'transcript', 'stt:interim', 'stt:final', 'stt:status', 'vad:state', 'applink:consent-request', 'hide:toggle', 'hide:state', 'smart:state', 'focus:input', 'chat:clear', 'whisper:download-progress', 'whisper:models-changed', 'questions:update'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
