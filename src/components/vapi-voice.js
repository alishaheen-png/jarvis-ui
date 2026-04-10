// ── Vapi Voice — Managed voice pipeline (Deepgram STT + Cartesia TTS) ──
//
// Uses @vapi-ai/web SDK. Requires public key + assistant ID.
// Much lower latency than Web Speech API (~400ms vs 1.5-2.5s)
// because Vapi handles STT → Claude → TTS entirely in the cloud.
//
// Usage:
//   import { startVapiCall, stopVapiCall, isVapiActive, initVapi } from './vapi-voice.js';
//   await initVapi(publicKey, assistantId);
//   startVapiCall();
//
// Events dispatched:
//   'vapi-state'           — { detail: 'idle' | 'listening' | 'speaking' | 'loading' }
//   'vapi-transcript'      — { detail: text } user speech
//   'vapi-response-text'   — { detail: text } assistant response
//   'vapi-error'           — { detail: message }

import Vapi from '@vapi-ai/web';

let vapi = null;
let _isActive = false;
let _publicKey = '';
let _assistantId = '';

function emit(name, detail) {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

function setState(state) {
  emit('vapi-state', state);
  // Also mirror to voice-state so existing UI handles it
  emit('voice-state', state);
  emit('agent-state', state === 'speaking' ? 'responding' : state === 'loading' ? 'thinking' : 'idle');
}

export function initVapi(publicKey, assistantId) {
  if (!publicKey || !assistantId) return;
  _publicKey = publicKey;
  _assistantId = assistantId;

  vapi = new Vapi(publicKey);

  vapi.on('call-start', () => {
    _isActive = true;
    setState('listening');
    console.log('[VAPI] Call started');
  });

  vapi.on('call-end', () => {
    _isActive = false;
    setState('idle');
    console.log('[VAPI] Call ended');
  });

  vapi.on('speech-start', () => {
    // Assistant is speaking
    setState('speaking');
  });

  vapi.on('speech-end', () => {
    // Assistant finished, back to listening
    if (_isActive) setState('listening');
  });

  vapi.on('message', (message) => {
    if (message.type === 'transcript') {
      if (message.role === 'user' && message.transcriptType === 'final') {
        emit('vapi-transcript', message.transcript);
        emit('voice-transcript', message.transcript);
        setState('loading');
      } else if (message.role === 'assistant') {
        emit('vapi-response-text', message.transcript);
        emit('voice-response-text', message.transcript);
      }
    }
  });

  vapi.on('error', (err) => {
    console.error('[VAPI] Error:', err);
    emit('vapi-error', err?.message || 'Vapi error');
    emit('voice-error', err?.message || 'Vapi error');
    _isActive = false;
    setState('idle');
  });

  console.log('[VAPI] Initialized with assistant:', assistantId);
}

export async function startVapiCall() {
  if (!vapi || !_assistantId) {
    emit('vapi-error', 'Vapi not initialized. Set VAPI_PUBLIC_KEY and VAPI_ASSISTANT_ID.');
    return;
  }
  if (_isActive) return;

  try {
    setState('loading');
    await vapi.start(_assistantId);
  } catch (err) {
    console.error('[VAPI] Start failed:', err);
    emit('vapi-error', err.message || 'Failed to start Vapi call');
    setState('idle');
  }
}

export async function stopVapiCall() {
  if (!vapi || !_isActive) return;
  try {
    await vapi.stop();
  } catch (err) {
    console.warn('[VAPI] Stop error:', err);
  }
  _isActive = false;
  setState('idle');
}

export function toggleVapiCall() {
  return _isActive ? stopVapiCall() : startVapiCall();
}

export function isVapiActive() {
  return _isActive;
}

export function getVapiInstance() {
  return vapi;
}
