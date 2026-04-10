// ── Chat Routes: /api/chat, /api/chat/upload, /api/history, /api/abort ──

import { Router } from 'express';
import multer from 'multer';
import os from 'os';
import path from 'path';
import { copyFile, unlink, mkdir } from 'fs/promises';
import { gwRequest } from '../gateway.js';

const router = Router();
const fileUpload = multer({ dest: os.tmpdir(), limits: { fileSize: 20 * 1024 * 1024 } });
const MEDIA_INBOUND = path.join(os.homedir(), '.openclaw', 'media', 'inbound');
const WARROOM_URL = process.env.WARROOM_URL || 'http://127.0.0.1:8888';

let msgCountToday = 0;
let msgCountDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

export function getMsgCount() { return msgCountToday; }
export function getMsgCountDate() { return msgCountDate; }

function bumpMsgCount() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  if (today !== msgCountDate) { msgCountToday = 0; msgCountDate = today; }
  msgCountToday++;
}

async function handleWarroomCommand(message) {
  const text = message.trim();

  let match = text.match(/^(?:fire|run|deploy)\s+(.+)$/i);
  if (match) {
    const agentId = match[1].trim().toLowerCase().replace(/\s+/g, '-');
    const resp = await fetch(`${WARROOM_URL}/api/agents/${encodeURIComponent(agentId)}/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: text }),
    });
    const data = await resp.json();
    return {
      intercepted: true,
      status: resp.status,
      body: { ok: resp.ok, routed: 'warroom.agent.fire', agentId, result: data },
    };
  }

  match = text.match(/^(?:approve)(?:\s+(\S+))?$/i);
  if (match) {
    const itemId = match[1];
    const url = itemId
      ? `${WARROOM_URL}/api/queue/${encodeURIComponent(itemId)}/approve`
      : `${WARROOM_URL}/api/queue/approve`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    return {
      intercepted: true,
      status: resp.status,
      body: { ok: resp.ok, routed: 'warroom.queue.approve', result: await resp.json() },
    };
  }

  match = text.match(/^(?:reject)(?:\s+(\S+))?(?:\s*[:\-]\s*(.+))?$/i);
  if (match) {
    const itemId = match[1];
    const reason = match[2] || 'Rejected from JARVIS UI chat';
    const url = itemId
      ? `${WARROOM_URL}/api/queue/${encodeURIComponent(itemId)}/reject`
      : `${WARROOM_URL}/api/queue/reject`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(itemId ? { reason } : {}),
    });
    return {
      intercepted: true,
      status: resp.status,
      body: { ok: resp.ok, routed: 'warroom.queue.reject', result: await resp.json() },
    };
  }

  return { intercepted: false };
}

// 檔案上傳
router.post('/chat/upload', fileUpload.array('files', 10), async (req, res) => {
  const message = req.body.message || '';
  const files = req.files || [];
  if (!files.length && !message) return res.status(400).json({ error: 'no files or message' });

  try {
    await mkdir(MEDIA_INBOUND, { recursive: true });
    const filePaths = [];
    for (const file of files) {
      const ext = path.extname(file.originalname) || '';
      const destName = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 6)}${ext}`;
      const destPath = path.join(MEDIA_INBOUND, destName);
      await copyFile(file.path, destPath);
      await unlink(file.path);
      filePaths.push(destPath);
    }

    let fullMessage = message;
    if (filePaths.length) {
      const fileList = filePaths.map(f => `[media attached: ${f}]`).join('\n');
      fullMessage = fullMessage ? `${fullMessage}\n\n${fileList}` : fileList;
    }

    bumpMsgCount();
    const idempotencyKey = `jarvis-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await gwRequest('chat.send', {
      message: fullMessage, sessionKey: req.app.locals.sessionKey,
      idempotencyKey, deliver: false,
    });
    res.json({ ok: true, files: filePaths.map(f => path.basename(f)), ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'upload error' });
  }
});

// 送出訊息
router.post('/chat', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  bumpMsgCount();
  try {
    const routed = await handleWarroomCommand(message);
    if (routed.intercepted) {
      return res.status(routed.status).json(routed.body);
    }

    const idempotencyKey = `jarvis-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await gwRequest('chat.send', {
      message, sessionKey: req.app.locals.sessionKey,
      idempotencyKey, deliver: false,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

// 歷史
router.get('/history', async (req, res) => {
  try {
    const result = await gwRequest('chat.history', {
      sessionKey: req.app.locals.sessionKey,
      limit: parseInt(req.query.limit) || 20,
    });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

// 中止
router.post('/abort', async (req, res) => {
  try {
    const result = await gwRequest('chat.abort', {});
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: err.message || 'gateway error' });
  }
});

export default router;
