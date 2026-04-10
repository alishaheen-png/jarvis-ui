// ── Vapi Webhook + Assistant Management ──
//
// POST /api/vapi/webhook  — Vapi calls this when JARVIS assistant uses a tool
//   Vapi sends: { type: "tool-calls", toolCallList: [...], call: {...} }
//   We forward the tool call to War Room /api/chat and return the result.
//
// GET  /api/vapi/info     — Returns assistant config for debugging
// POST /api/vapi/outbound — Initiate an outbound call (future use)
//
// IMPORTANT: For Vapi to reach this webhook in production you need a public URL.
// Locally, use: ngrok http 9999 → then set serverUrl in Vapi assistant config.

import express from 'express';
import fetch from 'node-fetch';

const router = express.Router();

const VAPI_PRIVATE_KEY = process.env.VAPI_PRIVATE_KEY || '';
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID || 'bd07af92-2f50-4c7e-be38-95d0438ac6e9';
const WARROOM_URL = process.env.WARROOM_URL || 'http://127.0.0.1:8888';

// ── Webhook: Vapi → Jarvis tool execution ──
router.post('/vapi/webhook', async (req, res) => {
  const payload = req.body;
  const type = payload?.message?.type || payload?.type;

  // Vapi sends different event shapes. Handle tool-calls:
  if (type === 'tool-calls') {
    const toolCallList = payload?.message?.toolCallList || payload?.toolCallList || [];
    const results = [];

    for (const call of toolCallList) {
      const toolName = call?.function?.name || call?.name || '';
      const args = call?.function?.arguments || call?.arguments || {};
      const callId = call?.id || '';

      let result = '';
      try {
        // Forward to War Room for execution
        const warroomResp = await fetch(`${WARROOM_URL}/api/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tool: toolName, args }),
        });

        if (warroomResp.ok) {
          const data = await warroomResp.json();
          result = data.result || JSON.stringify(data);
        } else {
          // Fallback: send as a chat message and get the response
          const chatResp = await fetch(`${WARROOM_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              message: `[TOOL_CALL] ${toolName}: ${JSON.stringify(args)}`,
              session_id: 'vapi',
            }),
          });
          const chatData = await chatResp.json();
          result = chatData.reply || chatData.response || 'Done.';
        }
      } catch (err) {
        console.error('[VAPI] Tool execution error:', err.message);
        result = `Error: ${err.message}`;
      }

      results.push({ toolCallId: callId, result });
    }

    // Vapi expects: { results: [{ toolCallId, result }] }
    return res.json({ results });
  }

  // Status updates (call-start, call-end, transcript, etc.) — just acknowledge
  if (type === 'status-update' || type === 'call-start' || type === 'call-end' ||
      type === 'transcript' || type === 'end-of-call-report') {
    // Optionally forward to War Room for logging
    const callData = payload?.message || payload;
    fetch(`${WARROOM_URL}/api/vapi/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, data: callData }),
    }).catch(() => {});
    return res.json({ received: true });
  }

  // Unknown type — log and ack
  console.log('[VAPI] Unknown webhook type:', type);
  res.json({ received: true });
});

// ── Info endpoint ──
router.get('/vapi/info', (req, res) => {
  res.json({
    assistantId: VAPI_ASSISTANT_ID,
    hasPrivateKey: !!VAPI_PRIVATE_KEY,
    webhookPath: '/api/vapi/webhook',
    note: 'For local dev, use ngrok to expose this webhook to Vapi',
  });
});

// ── Update Vapi assistant serverUrl (call once when you have a public URL) ──
router.post('/vapi/set-webhook', async (req, res) => {
  const { webhookUrl } = req.body;
  if (!webhookUrl) return res.status(400).json({ error: 'webhookUrl required' });
  if (!VAPI_PRIVATE_KEY) return res.status(500).json({ error: 'VAPI_PRIVATE_KEY not set' });

  try {
    const resp = await fetch(`https://api.vapi.ai/assistant/${VAPI_ASSISTANT_ID}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${VAPI_PRIVATE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serverUrl: webhookUrl }),
    });
    const data = await resp.json();
    res.json({ updated: true, assistant: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
