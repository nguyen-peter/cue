// Streaming Speech-to-Text via OpenAI Realtime API (WebSocket transcription session)
// or Deepgram Nova streaming. Falls back to batch Whisper/Gemini if streaming unavailable.
//
// This module manages a persistent WebSocket connection for real-time transcription
// with sub-200ms latency, interim results, and automatic reconnection.

const { looksLikeHallucination, buildVocabTerms } = require('./stt');
const { pcmToWav } = require('./wav');
const { CURRENT_GEMINI_DEFAULT } = require('./llm');

// Deepgram caps how many keyterms can usefully be boosted per session; stay
// well inside it so base vocab + résumé terms never degrade recognition.
const MAX_DEEPGRAM_KEYTERMS = 50;

// Streaming 16 kHz -> 24 kHz resampler (linear interpolation, ratio 2:3).
//
// Audio arrives in small chunks. Resampling each chunk on its own has no "next
// sample" for the last few outputs, so it repeats the final sample — a small
// step in the waveform at every chunk boundary, ten times a second. This keeps
// the last sample and the output position between calls, so the stream comes
// out exactly as if it had been resampled in one piece.
class Resampler16to24 {
  constructor() {
    this.reset();
  }

  reset() {
    this.previous = 0;       // last input sample of the previous chunk
    this.positionThirds = 0; // next output position, in thirds of an input sample, relative to this chunk
  }

  process(pcm16kHz) {
    const samples = Math.floor(pcm16kHz.length / 2);
    if (!samples) return Buffer.alloc(0);
    const sampleAt = (index) => (index < 0 ? this.previous : pcm16kHz.readInt16LE(index * 2));
    const out = Buffer.alloc((Math.ceil(samples * 1.5) + 2) * 2);
    let written = 0;
    let position = this.positionThirds;
    // An output between input samples i and i+1 needs both, so anything past
    // the last sample waits for the next chunk.
    while (Math.floor(position / 3) + 1 <= samples - 1) {
      const index = Math.floor(position / 3);
      const fraction = (position - index * 3) / 3;
      const a = sampleAt(index);
      const b = sampleAt(index + 1);
      const value = Math.round(a + (b - a) * fraction);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, value)), written);
      written += 2;
      position += 2;
    }
    this.previous = pcm16kHz.readInt16LE((samples - 1) * 2);
    this.positionThirds = position - samples * 3;
    return out.subarray(0, written);
  }
}

// ============================================================================
// OpenAI Realtime Transcription Session (WebSocket)
// Uses the dedicated transcription session type for lowest latency streaming STT
// ============================================================================

class OpenAIRealtimeSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'gpt-realtime-whisper';
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._pendingAudio = [];
    this._sessionReady = false;
    this._resampler = new Resampler16to24();
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      // A new connection is a new audio stream: don't interpolate from the
      // last sample of the previous one.
      this._resampler.reset();
      // GA transcription endpoint: use ?intent=transcription (NOT ?model=)
      // The transcription model goes inside the session config
      const url = 'wss://api.openai.com/v1/realtime?intent=transcription';

      this.ws = new WebSocket(url, {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`
        }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');

        // Configure the transcription session (GA format)
        this._sendEvent({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: this.model,
                  language: 'en'
                }
              }
            }
          }
        });
      });

      this.ws.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          this._handleEvent(event);
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._sessionReady = false;
        this.onStatusChange('disconnected');
        if (code !== 1000 && !this.reconnecting) {
          this._attemptReconnect();
        }
      });

      this.ws.on('error', (err) => {
        this.onError({ provider: 'openai-realtime', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'openai-realtime', message: e.message, status: null });
    }
  }

  _handleEvent(event) {
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        this._sessionReady = true;
        this._flushPendingAudio();
        break;

      case 'conversation.item.input_audio_transcription.delta':
        if (event.delta) {
          this.onInterim(event.delta);
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        // Same silence-artifact filter the Deepgram and batch paths apply
        // ("Thank you.", "Thanks for watching.").
        if (event.transcript && event.transcript.trim() && !looksLikeHallucination(event.transcript)) {
          this.onTranscript(event.transcript.trim());
        }
        break;

      case 'input_audio_buffer.speech_started':
        break;

      case 'input_audio_buffer.speech_stopped':
        break;

      case 'input_audio_buffer.committed':
        break;

      case 'error':
        this.onError({
          provider: 'openai-realtime',
          message: event.error?.message || 'Unknown realtime error',
          status: event.error?.code
        });
        break;
    }
  }

  sendAudio(pcmBuffer) {
    if (!this.connected || !this._sessionReady) {
      // Buffer audio until session is ready (max 5 seconds worth)
      this._pendingAudio.push(pcmBuffer);
      if (this._pendingAudio.length > 80) this._pendingAudio.shift();
      return;
    }

    this._appendAudio(pcmBuffer);
  }

  // Resample 16kHz -> 24kHz (the API requires 24kHz) and append to the session.
  _appendAudio(pcmBuffer) {
    const resampled = this._resampler.process(Buffer.from(pcmBuffer));
    if (!resampled.length) return;
    this._sendEvent({
      type: 'input_audio_buffer.append',
      audio: resampled.toString('base64')
    });
  }

  _flushPendingAudio() {
    while (this._pendingAudio.length > 0) this._appendAudio(this._pendingAudio.shift());
  }

  _sendEvent(event) {
    if (this.ws && this.ws.readyState === 1) { // WebSocket.OPEN
      this.ws.send(JSON.stringify(event));
    }
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'openai-realtime', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this.reconnecting = true;
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    setTimeout(() => {
      this.reconnecting = false;
      this.connect();
    }, Math.min(delay, 16000));
  }

  disconnect() {
    this._sessionReady = false;
    this._pendingAudio = [];
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Deepgram Nova Streaming STT (WebSocket)
// Ultra-low latency, supports interim results, speaker diarization, punctuation
// ============================================================================

class DeepgramStreamingSTT {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || 'nova-3';
    // nova-3 keyterm prompting: proper nouns and jargon to bias recognition
    // toward (résumé/JD terms) — the streaming equivalent of the Whisper
    // vocabulary prompt the batch path already uses.
    this.keyterms = Array.isArray(options.keyterms)
      ? options.keyterms.filter((t) => typeof t === 'string' && t.trim())
      : [];
    this.ws = null;
    this.connected = false;
    this.onTranscript = options.onTranscript || (() => {});
    this.onInterim = options.onInterim || (() => {});
    this.onError = options.onError || (() => {});
    this.onStatusChange = options.onStatusChange || (() => {});
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._reconnectDelay = 1000;
    this._keepAliveInterval = null;
    this._committed = ''; // is_final segments not yet closed out by speech_final
  }

  // Extracted from connect() so keyterm handling is unit-testable.
  buildQueryParams() {
    const params = new URLSearchParams({
      model: this.model,
      language: 'en',
      smart_format: 'true',
      interim_results: 'true',
      utterance_end_ms: '1000',
      vad_events: 'true',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      endpointing: '300',
      punctuate: 'true'
    });
    for (const term of this.keyterms.slice(0, MAX_DEEPGRAM_KEYTERMS)) {
      params.append('keyterm', term.trim());
    }
    return params;
  }

  async connect() {
    if (this.ws && this.connected) return;

    try {
      const WebSocket = require('ws');
      const url = `wss://api.deepgram.com/v1/listen?${this.buildQueryParams().toString()}`;

      this.ws = new WebSocket(url, {
        headers: { 'Authorization': `Token ${this.apiKey}` }
      });

      this.ws.on('open', () => {
        this.connected = true;
        this._reconnectAttempts = 0;
        this.onStatusChange('connected');
        // Keep-alive every 3 seconds to prevent timeout
        this._keepAliveInterval = setInterval(() => {
          if (this.ws && this.ws.readyState === 1) {
            this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
          }
        }, 3000);
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this._handleMessage(msg);
        } catch (e) { /* ignore */ }
      });

      this.ws.on('close', (code) => {
        this.connected = false;
        this._clearKeepAlive();
        this.onStatusChange('disconnected');
        if (code !== 1000) this._attemptReconnect();
      });

      this.ws.on('error', (err) => {
        this.onError({ provider: 'deepgram', message: err.message, status: null });
      });

    } catch (e) {
      this.onError({ provider: 'deepgram', message: e.message, status: null });
    }
  }

  _handleMessage(msg) {
    if (msg.type === 'Results') {
      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const text = (alt.transcript || '').trim();

      // Deepgram splits one spoken sentence into several is_final segments and only sets
      // speech_final on the last one. Accumulate the is_final pieces and emit a single turn
      // at speech_final so a sentence is not fragmented across transcript rows.
      if (msg.speech_final) {
        const full = ((this._committed || '') + ' ' + text).trim();
        this._committed = '';
        if (full && !looksLikeHallucination(full)) this.onTranscript(full);
        this.onInterim('');
        return;
      }
      if (!text) return;
      if (msg.is_final) {
        this._committed = ((this._committed || '') + ' ' + text).trim();
        this.onInterim(this._committed);
      } else {
        this.onInterim(((this._committed || '') + ' ' + text).trim());
      }
    } else if (msg.type === 'UtteranceEnd') {
      // Safety net: if endpointing never produced a speech_final, flush whatever is_final
      // segments we accumulated so the turn is not silently dropped.
      this._flushCommitted();
    } else if (msg.type === 'Error') {
      this.onError({ provider: 'deepgram', message: msg.description || msg.message, status: msg.variant });
    }
  }

  _flushCommitted() {
    const full = (this._committed || '').trim();
    this._committed = '';
    if (full && !looksLikeHallucination(full)) this.onTranscript(full);
    this.onInterim('');
  }

  sendAudio(pcmBuffer) {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(Buffer.from(pcmBuffer));
    }
  }

  _clearKeepAlive() {
    if (this._keepAliveInterval) { clearInterval(this._keepAliveInterval); this._keepAliveInterval = null; }
  }

  _attemptReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this.onError({ provider: 'deepgram', message: 'Max reconnection attempts reached', status: null });
      return;
    }
    this._reconnectAttempts++;
    const delay = this._reconnectDelay * Math.pow(2, this._reconnectAttempts - 1);
    setTimeout(() => this.connect(), Math.min(delay, 16000));
  }

  disconnect() {
    this._flushCommitted();
    this._clearKeepAlive();
    if (this.ws) {
      // Send CloseStream message for clean shutdown
      try { this.ws.send(JSON.stringify({ type: 'CloseStream' })); } catch (e) { /* ignore */ }
      this.ws.close(1000);
      this.ws = null;
    }
    this.connected = false;
  }
}

// ============================================================================
// Batch STT (enhanced version of the original — used as fallback)
// Supports Whisper and Gemini with better error handling
// ============================================================================

async function transcribeBatchOpenAI(apiKey, wav, model) {
  const OpenAI = require('openai');
  const toFile = OpenAI.toFile || require('openai/uploads').toFile;
  const client = new OpenAI({ apiKey });
  const file = await toFile(wav, 'audio.wav', { type: 'audio/wav' });
  const res = await client.audio.transcriptions.create({
    file,
    model: model || 'whisper-1',
    response_format: 'text',
    language: 'en'
  });
  return (typeof res === 'string' ? res : res.text || '').trim();
}

async function transcribeBatchGemini(apiKey, wav) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  const res = await ai.models.generateContent({
    model: CURRENT_GEMINI_DEFAULT,
    contents: [{ role: 'user', parts: [
      { text: 'Transcribe this audio verbatim. Return only the spoken words with no commentary. If there is no clear speech, return an empty response.' },
      { inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }
    ] }]
  });
  return ((res && res.text) || '').trim();
}

// ============================================================================
// Unified Streaming STT Factory
// Creates the best available streaming STT based on the user's API keys.
// Priority: Deepgram (lowest latency) > OpenAI Realtime > Batch fallback
// ============================================================================

function createStreamingSTT(settings, channel, callbacks) {
  const keys = settings.apiKeys || {};
  const selectedProvider = settings.sttProvider || 'auto';
  const { onTranscript, onInterim, onError, onStatusChange } = callbacks;

  if (selectedProvider === 'local' || selectedProvider === 'gemini' || selectedProvider === 'groq') {
    return { type: 'batch', provider: selectedProvider, instance: null };
  }

  // Priority 1: Deepgram (purpose-built for streaming STT, lowest latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'deepgram') && keys.deepgram) {
    const stt = new DeepgramStreamingSTT(keys.deepgram, {
      model: 'nova-3',
      keyterms: buildVocabTerms(settings),
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'deepgram', instance: stt };
  }

  // Priority 2: OpenAI Realtime API (excellent quality, slightly higher latency)
  if ((selectedProvider === 'auto' || selectedProvider === 'openai') && keys.openai) {
    const stt = new OpenAIRealtimeSTT(keys.openai, {
      model: 'gpt-realtime-whisper', // only this model gives true streaming deltas
      onTranscript: (text) => onTranscript(channel, text),
      onInterim: (text) => onInterim(channel, text),
      onError,
      onStatusChange: (status) => onStatusChange(channel, status)
    });
    return { type: 'streaming', provider: 'openai-realtime', instance: stt };
  }

  // Priority 3: Batch fallback (Gemini or Whisper via old system)
  return {
    type: 'batch',
    provider: selectedProvider === 'auto' && keys.gemini ? 'gemini' : 'none',
    instance: null
  };
}

module.exports = {
  Resampler16to24,
  OpenAIRealtimeSTT,
  DeepgramStreamingSTT,
  createStreamingSTT,
  transcribeBatchOpenAI,
  transcribeBatchGemini
};
