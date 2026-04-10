// ── Voice Chat Route: /api/voice ──

import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { unlink, readFile } from 'fs/promises';
import { ttsSentence, splitSentences, getCurrentVoice } from '../tts.js';

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });
const WHISPER_MODEL = path.join(os.homedir(), '.whisper-models', 'ggml-base.bin');
const WARROOM_URL = process.env.WARROOM_URL || 'http://127.0.0.1:8888';

function resolveOpenAiKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const fallbackEnv = '/Users/flapkap/Documents/propelbd-jarvis/.env';
  if (!fs.existsSync(fallbackEnv)) return '';
  const match = fs.readFileSync(fallbackEnv, 'utf8').match(/^OPENAI_API_KEY=(.+)$/m);
  return match?.[1]?.trim() || '';
}

async function whisperTranscribe(audioPath, lang = 'en') {
  const apiKey = resolveOpenAiKey();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured for transcription fallback');
  }

  const form = new FormData();
  const audio = await readFile(audioPath);
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
  form.append('model', 'whisper-1');
  form.append('language', lang);
  form.append('response_format', 'json');

  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Whisper fallback failed: ${resp.status} ${body.slice(0, 200)}`);
  }

  const data = await resp.json();
  return (data.text || '').trim();
}

// 訊息計數（共用）
let msgCountToday = 0;
let msgCountDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

router.post('/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file required' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked',
  });

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const audioPath = req.file.path;

  try {
    const transcript = await whisperTranscribe(audioPath, 'en');
    if (!transcript) { send({ type: 'error', message: '無法辨識語音' }); send({ type: 'done' }); res.end(); return; }

    send({ type: 'transcript', text: transcript });
    console.log(`[VOICE] 轉錄: "${transcript}"`);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    if (today !== msgCountDate) { msgCountToday = 0; msgCountDate = today; }
    msgCountToday++;

    const voice = getCurrentVoice();
    const chatResp = await fetch(`${WARROOM_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: transcript }),
    });

    if (!chatResp.ok) {
      const body = await chatResp.text();
      throw new Error(`War Room chat failed: ${chatResp.status} ${body.slice(0, 200)}`);
    }

    const chatData = await chatResp.json();
    const responseText = (chatData.reply || '').trim();
    if (!responseText) {
      send({ type: 'done', fullText: '' });
      return;
    }

    send({ type: 'text-chunk', text: responseText });

    // Generate all TTS chunks in PARALLEL — no gaps between sentences
    const sentences = splitSentences(responseText);
    const ttsPromises = sentences.map(s => ttsSentence(s, voice).catch(() => null));
    for (const promise of ttsPromises) {
      const result = await promise;
      if (result && result.buffer && result.buffer.length > 0) {
        send({ type: 'tts-chunk', audio: result.buffer.toString('base64'), contentType: result.contentType, text: '' });
      }
    }

    send({ type: 'done', fullText: responseText });
  } catch (err) {
    console.error('[VOICE] Error:', err);
    send({ type: 'error', message: err.message });
  } finally {
    try { await unlink(audioPath); } catch {}
    res.end();
  }
});

// Text-based voice: accepts pre-transcribed text (from browser Web Speech API)
// Returns same NDJSON stream as /api/voice but skips Whisper entirely
router.post('/voice/text', async (req, res) => {
  const transcript = (req.body?.text || '').trim();
  if (!transcript) return res.status(400).json({ error: 'text required' });

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache', 'Transfer-Encoding': 'chunked',
  });

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    send({ type: 'transcript', text: transcript });
    console.log(`[VOICE/TEXT] "${transcript}"`);

    const voice = getCurrentVoice();
    const chatResp = await fetch(`${WARROOM_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: transcript }),
    });

    if (!chatResp.ok) {
      const body = await chatResp.text();
      throw new Error(`War Room chat failed: ${chatResp.status} ${body.slice(0, 200)}`);
    }

    const chatData = await chatResp.json();
    const responseText = (chatData.reply || '').trim();
    if (!responseText) { send({ type: 'done', fullText: '' }); res.end(); return; }

    send({ type: 'text-chunk', text: responseText });

    // Parallel TTS — all sentences start generating simultaneously
    const sentences = splitSentences(responseText);
    const ttsPromises = sentences.map(s => ttsSentence(s, voice).catch(() => null));
    for (const promise of ttsPromises) {
      const result = await promise;
      if (result && result.buffer && result.buffer.length > 0) {
        send({ type: 'tts-chunk', audio: result.buffer.toString('base64'), contentType: result.contentType, text: '' });
      }
    }

    send({ type: 'done', fullText: responseText });
  } catch (err) {
    console.error('[VOICE/TEXT] Error:', err);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

export default router;
