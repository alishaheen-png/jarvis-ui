// ── WhatsApp Web integration via whatsapp-web.js ──
//
// On server start, initializes a WhatsApp Web client.
// First run: logs QR code to terminal — scan with Ali's phone.
// After scan: session saved to .wwebjs_auth/ — no re-scan needed.
//
// Endpoints:
//   GET  /api/whatsapp/status  — connection status + phone info
//   POST /api/whatsapp/send    — send message { number, message }
//   GET  /api/whatsapp/qr      — get QR as base64 (for embedding in UI)
//
// Python side calls: POST http://localhost:9999/api/whatsapp/send
// to let Jarvis autonomously message contacts.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let waClient = null;
let waState = 'initializing'; // initializing | qr_pending | authenticated | ready | disconnected
let qrCode = null;
let waInfo = null;

async function initWhatsApp() {
  try {
    // Dynamic import — whatsapp-web.js is CJS, named exports may be on .default
    const waModule = await import('whatsapp-web.js');
    const { Client, LocalAuth } = waModule.default || waModule;

    waClient = new Client({
      authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '../../.wwebjs_auth'),
      }),
      puppeteer: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-gpu',
        ],
      },
    });

    waClient.on('qr', async (qr) => {
      waState = 'qr_pending';
      qrCode = qr;
      console.log('\n[WHATSAPP] ── Scan this QR code with Ali\'s WhatsApp ──');
      // Print QR in terminal
      try {
        const { default: qrTerminal } = await import('qrcode-terminal');
        qrTerminal.generate(qr, { small: true });
      } catch {
        console.log('[WHATSAPP] QR:', qr.substring(0, 60) + '...');
      }
      console.log('[WHATSAPP] ── QR also available at GET /api/whatsapp/qr ──\n');
    });

    waClient.on('authenticated', () => {
      waState = 'authenticated';
      qrCode = null;
      console.log('[WHATSAPP] Authenticated');
    });

    waClient.on('ready', async () => {
      waState = 'ready';
      try {
        waInfo = waClient.info;
        console.log(`[WHATSAPP] Ready — ${waInfo?.pushname} (${waInfo?.wid?.user})`);
      } catch {
        console.log('[WHATSAPP] Ready');
      }
    });

    waClient.on('disconnected', (reason) => {
      waState = 'disconnected';
      waInfo = null;
      console.warn('[WHATSAPP] Disconnected:', reason);
      // Reconnect after 30s
      setTimeout(initWhatsApp, 30000);
    });

    waClient.on('auth_failure', (msg) => {
      waState = 'disconnected';
      console.error('[WHATSAPP] Auth failure:', msg);
    });

    await waClient.initialize();
  } catch (err) {
    console.warn('[WHATSAPP] Failed to initialize:', err.message);
    waState = 'disconnected';
  }
}

// Start WhatsApp client in background (don't block server boot)
initWhatsApp().catch(() => {});

// ── Status ──
router.get('/whatsapp/status', (req, res) => {
  res.json({
    state: waState,
    connected: waState === 'ready',
    phone: waInfo?.wid?.user || null,
    name: waInfo?.pushname || null,
    qrPending: waState === 'qr_pending',
  });
});

// ── Get QR as text (for embedding in UI) ──
router.get('/whatsapp/qr', (req, res) => {
  if (!qrCode) {
    return res.json({ available: false, state: waState });
  }
  res.json({ available: true, qr: qrCode, state: waState });
});

// ── Send Message ──
router.post('/whatsapp/send', async (req, res) => {
  const { number, message } = req.body;

  if (!number || !message) {
    return res.status(400).json({ error: 'number and message required' });
  }

  if (waState !== 'ready') {
    return res.status(503).json({
      error: `WhatsApp not ready (state: ${waState})`,
      hint: waState === 'qr_pending' ? 'Scan QR at GET /api/whatsapp/qr' : 'Initializing...',
    });
  }

  try {
    // Normalize number: strip spaces, dashes; ensure +country code
    const normalized = number.replace(/[\s\-()]/g, '');
    const chatId = normalized.includes('@') ? normalized : `${normalized}@c.us`;

    await waClient.sendMessage(chatId, message);
    console.log(`[WHATSAPP] Sent to ${normalized}: ${message.substring(0, 60)}`);
    res.json({ sent: true, to: normalized });
  } catch (err) {
    console.error('[WHATSAPP] Send failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Get Chats (for UI display) ──
router.get('/whatsapp/chats', async (req, res) => {
  if (waState !== 'ready') {
    return res.json({ chats: [], state: waState });
  }
  try {
    const chats = await waClient.getChats();
    const simplified = chats.slice(0, 20).map(c => ({
      id: c.id._serialized,
      name: c.name,
      unread: c.unreadCount,
      timestamp: c.timestamp,
    }));
    res.json({ chats: simplified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
