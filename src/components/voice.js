// ── JARVIS Voice — WebSocket streaming + Web Audio API gapless playback ──
//
// Architecture:
//   Chrome Web Speech API (STT) → WS proxy → War Room /ws/voice
//   War Room → Kokoro TTS (local, high-quality) → WAV chunks → browser
//   Browser: Web Audio API schedules chunks back-to-back with ZERO gap
//
// Key improvements over HTML Audio element:
//   - AudioContext.decodeAudioData + scheduled BufferSourceNode = gapless
//   - All chunks pre-scheduled on audio timeline, no gaps between sentences

let ws = null;
let isVoiceMode = false;
let recognition = null;
let isProcessing = false;
let isSpeaking = false;
let pendingTranscript = '';
let silenceTimer = null;
let fullResponseText = '';

let onStateChange = null;

const SILENCE_DELAY_MS = 850; // ms pause before sending to Jarvis

// ── Web Audio API state ──
let audioCtx = null;
let nextStartTime = 0;       // When next chunk should start on audio timeline
let scheduledCount = 0;      // Chunks scheduled but not yet played
let audioGeneration = 0;     // Incremented on stop to invalidate callbacks

function getAudioCtx() {
  if (!audioCtx || audioCtx.state === 'closed') {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    nextStartTime = audioCtx.currentTime;
  }
  return audioCtx;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/voice`;
}

function setState(state) {
  if (onStateChange) onStateChange(state);
  window.dispatchEvent(new CustomEvent('voice-state', { detail: state }));
}

// ── WebSocket ──

function connectWS() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  ws = new WebSocket(wsUrl());
  const pending = [];

  ws.onopen = () => {
    console.log('[VOICE] WS connected');
    for (const msg of pending) ws.send(msg);
    pending.length = 0;
  };

  ws.onmessage = (e) => {
    try { handleWSMessage(JSON.parse(e.data)); } catch {}
  };

  ws.onclose = () => {
    ws = null;
    if (isVoiceMode) setTimeout(connectWS, 1500);
  };

  ws.onerror = () => ws?.close();

  // Attach pending buffer to ws so sendToJarvis can use it
  ws._pending = pending;
}

function handleWSMessage(data) {
  const type = data.type;

  if (type === 'text_chunk' || type === 'text-chunk') {
    const chunk = (data.text || '').trim();
    if (!chunk) return;
    fullResponseText += (fullResponseText ? ' ' : '') + chunk;
    window.dispatchEvent(new CustomEvent('voice-response-text', { detail: chunk }));
    window.dispatchEvent(new CustomEvent('agent-state', { detail: 'responding' }));
  }

  else if (type === 'tts_chunk' || type === 'tts-chunk') {
    if (data.audio) {
      const ct = data.contentType || data.content_type || 'audio/mpeg';
      scheduleAudioChunk(data.audio, ct);
    }
  }

  else if (type === 'done') {
    waitAudioDone().then(() => {
      isSpeaking = false;
      isProcessing = false;
      fullResponseText = '';
      if (isVoiceMode) {
        setState('listening');
        window.dispatchEvent(new CustomEvent('agent-state', { detail: 'idle' }));
        pendingTranscript = '';
        try { recognition?.start(); } catch {}
      }
    });
  }

  else if (type === 'error') {
    console.warn('[VOICE] Backend error:', data.text || data.message);
    isSpeaking = false;
    isProcessing = false;
    fullResponseText = '';
    if (isVoiceMode) {
      setState('listening');
      try { recognition?.start(); } catch {}
    }
  }
}

// ── Web Audio API gapless playback ──

async function scheduleAudioChunk(base64, contentType) {
  const gen = audioGeneration;

  // Decode base64
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const ctx = getAudioCtx();

  // Resume if browser suspended (autoplay policy)
  if (ctx.state === 'suspended') await ctx.resume();

  try {
    // decodeAudioData requires a copy of the ArrayBuffer
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

    if (gen !== audioGeneration) return; // stopped since we started decoding

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    // Schedule: start exactly when previous chunk ends (tiny 20ms lookahead for safety)
    const now = ctx.currentTime;
    const startAt = nextStartTime < now + 0.02 ? now + 0.02 : nextStartTime;
    source.start(startAt);
    nextStartTime = startAt + audioBuffer.duration;
    scheduledCount++;

    if (isSpeaking) setState('speaking');

    source.onended = () => {
      if (gen === audioGeneration) scheduledCount = Math.max(0, scheduledCount - 1);
    };
  } catch (e) {
    console.warn('[VOICE] Audio decode error:', e.message);
  }
}

function stopAudio() {
  clearTimeout(silenceTimer);
  audioGeneration++;     // invalidate all pending decode callbacks
  scheduledCount = 0;
  // Close context to immediately stop all scheduled audio
  if (audioCtx) {
    audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  nextStartTime = 0;
}

function waitAudioDone() {
  return new Promise(resolve => {
    const gen = audioGeneration;
    const check = () => {
      if (gen !== audioGeneration) { resolve(); return; }
      const ctx = audioCtx;
      if (!ctx || scheduledCount === 0 || nextStartTime <= ctx.currentTime + 0.05) {
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

// ── STT — Chrome Web Speech API ──

function buildRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const r = new SR();
  r.lang = 'en-US';
  r.continuous = true;
  r.interimResults = true;
  r.maxAlternatives = 1;

  r.onresult = (event) => {
    if (isProcessing || isSpeaking) return;

    clearTimeout(silenceTimer);

    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        pendingTranscript += (pendingTranscript ? ' ' : '') + event.results[i][0].transcript.trim();
      }
    }

    if (!pendingTranscript) return;

    silenceTimer = setTimeout(() => {
      const text = pendingTranscript.trim();
      pendingTranscript = '';
      if (text.length < 2) return;
      sendToJarvis(text);
    }, SILENCE_DELAY_MS);
  };

  r.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    if (e.error === 'not-allowed') {
      window.dispatchEvent(new CustomEvent('voice-error', {
        detail: 'Microphone access denied. Click the address bar mic icon to allow.',
      }));
      isVoiceMode = false;
      setState('idle');
      return;
    }
    console.warn('[VOICE] STT error:', e.error);
  };

  r.onend = () => {
    if (isVoiceMode && !isProcessing) {
      try { recognition?.start(); } catch {}
    }
  };

  return r;
}

// ── Send to War Room via WebSocket ──

function sendToJarvis(text) {
  console.log('[VOICE] →', text);

  isProcessing = true;
  isSpeaking = true;
  fullResponseText = '';
  setState('processing');
  try { recognition?.stop(); } catch {}

  window.dispatchEvent(new CustomEvent('voice-transcript', { detail: text }));
  window.dispatchEvent(new CustomEvent('agent-state', { detail: 'thinking' }));

  const msg = JSON.stringify({ text });

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    connectWS();
    // Buffer message — flushed in ws.onopen
    if (ws?._pending) ws._pending.push(msg);
    return;
  }

  ws.send(msg);
}

// ── Public API ──

export async function startVoiceMode() {
  if (isVoiceMode) return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    window.dispatchEvent(new CustomEvent('voice-error', {
      detail: 'Voice not supported. Use Chrome or Edge.',
    }));
    return;
  }

  isVoiceMode = true;
  connectWS();
  recognition = buildRecognition();

  try {
    recognition.start();
    setState('listening');
    console.log('[VOICE] Active — Web Audio API + Kokoro TTS');
  } catch (err) {
    console.error('[VOICE] Failed to start:', err);
    isVoiceMode = false;
    setState('idle');
  }
}

export async function stopVoiceMode() {
  isVoiceMode = false;
  clearTimeout(silenceTimer);
  pendingTranscript = '';
  try { recognition?.stop(); } catch {}
  recognition = null;
  stopAudio();
  if (ws) { ws.close(); ws = null; }
  setState('idle');
}

export function toggleVoiceMode() {
  return isVoiceMode ? stopVoiceMode() : startVoiceMode();
}

export function isVoiceActive() { return isVoiceMode; }
export function setOnStateChange(cb) { onStateChange = cb; }
