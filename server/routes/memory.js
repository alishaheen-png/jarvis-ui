// ── Memory Routes: /api/memory ──
// Bridges JARVIS UI → FalkorDB/Graphiti via War Room API (localhost:8888)
// Also falls back to OpenClaw local memory files if War Room is down

import { Router } from 'express';
import { readFile, readdir, access } from 'fs/promises';
import os from 'os';
import path from 'path';

const router = Router();
const WARROOM_URL = process.env.WARROOM_URL || 'http://127.0.0.1:8888';
const MEMORY_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'memory');

// Primary: FalkorDB via War Room API
function formatEpisodes(episodes, stats, limit, source) {
  const days = [];
  const byDate = {};
  for (const ep of episodes) {
    const date = ep.created_at ? ep.created_at.slice(0, 10) : 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(ep.body || ep.name || '');
  }
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  for (const [date, topics] of Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]))) {
    let label = '';
    if (date === todayStr) label = 'TODAY';
    else if (date === yesterdayStr) label = 'YESTERDAY';
    days.push({ date, displayDate: date.slice(5), label, topics: topics.map(t => t.substring(0, 120)) });
  }
  return {
    days,
    totalFiles: stats.nodes || episodes.length,
    totalNodes: stats.nodes,
    totalEdges: stats.edges,
    groups: stats.groups || {},
    lastUpdate: days.length > 0 ? days[0].label || days[0].date : null,
    hasMore: episodes.length >= limit,
    source,
  };
}

router.get('/memory', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;

  // Always get stats (direct FalkorDB, no OpenAI needed)
  let stats = { nodes: 0, edges: 0 };
  try {
    const statsResp = await fetch(`${WARROOM_URL}/api/memory/stats`);
    if (statsResp.ok) stats = await statsResp.json();
  } catch {}

  try {
    // Try graphiti search (may fail if OpenAI quota exceeded)
    const resp = await fetch(`${WARROOM_URL}/api/memory/recent?limit=${limit}`);
    if (resp.ok) {
      const data = await resp.json();
      const episodes = data.episodes || [];
      if (episodes.length > 0) {
        return res.json(formatEpisodes(episodes, stats, limit, 'graphiti'));
      }
    }
  } catch (e) {
    console.warn('[MEMORY] Graphiti search failed:', e.message);
  }

  try {
    // Fallback: direct FalkorDB query (no OpenAI embeddings needed)
    const resp = await fetch(`${WARROOM_URL}/api/memory/nodes?limit=${limit}`);
    if (resp.ok) {
      const data = await resp.json();
      const episodes = data.episodes || [];
      if (episodes.length > 0) {
        return res.json(formatEpisodes(episodes, stats, limit, 'falkordb_direct'));
      }
    }
  } catch (e) {
    console.warn('[MEMORY] Direct FalkorDB query failed:', e.message);
  }

  // Fallback: OpenClaw local memory files
  try {
    let entries = [];
    try {
      const files = await readdir(MEMORY_DIR);
      entries = files.filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort((a, b) => b.localeCompare(a));
    } catch {}

    const sliced = entries.slice(0, limit);
    const days = [];
    for (const filename of sliced) {
      const date = filename.replace('.md', '');
      let topics = [];
      try {
        const content = await readFile(path.join(MEMORY_DIR, filename), 'utf-8');
        for (const line of content.split('\n')) {
          const match = line.match(/^## (.+)/);
          if (match) topics.push(match[1].trim());
        }
      } catch {}
      days.push({ date, displayDate: date.slice(5), label: '', topics });
    }

    res.json({ days, totalFiles: entries.length, lastUpdate: null, hasMore: false, source: 'local' });
  } catch (err) {
    res.status(500).json({ error: 'failed to read memory' });
  }
});

// Memory search — proxies to War Room
router.get('/memory/search', async (req, res) => {
  const query = req.query.q || '';
  if (!query) return res.json({ results: [] });

  try {
    const resp = await fetch(`${WARROOM_URL}/api/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 10 }),
    });
    if (resp.ok) return res.json(await resp.json());
  } catch {}
  res.json({ results: [], error: 'War Room API unavailable' });
});

// Memory stats — proxies to War Room
router.get('/memory/stats', async (req, res) => {
  try {
    const resp = await fetch(`${WARROOM_URL}/api/memory/stats`);
    if (resp.ok) return res.json(await resp.json());
  } catch {}
  res.json({ nodes: 0, edges: 0, error: 'War Room API unavailable' });
});

// Memory save — writes to FalkorDB via War Room
router.post('/memory', async (req, res) => {
  const { fact, content, group_id, source } = req.body || {};
  const text = fact || content || '';
  if (!text) return res.status(400).json({ error: 'fact or content required' });

  try {
    const resp = await fetch(`${WARROOM_URL}/api/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: text, group_id: group_id || 'propelbd', source: source || 'jarvis_ui' }),
    });
    if (resp.ok) return res.json(await resp.json());
    const err = await resp.json();
    return res.status(resp.status).json(err);
  } catch (e) {
    res.status(502).json({ error: `War Room save failed: ${e.message}` });
  }
});

// Memory save from chat — when JARVIS UI chat produces something worth remembering
router.post('/memory/save', async (req, res) => {
  const { body: text, source, group_id } = req.body || {};
  if (!text) return res.status(400).json({ error: 'body required' });

  try {
    const resp = await fetch(`${WARROOM_URL}/api/memory/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fact: text, group_id: group_id || 'propelbd', source: source || 'jarvis_ui_chat' }),
    });
    if (resp.ok) return res.json(await resp.json());
    const err = await resp.json();
    return res.status(resp.status).json(err);
  } catch (e) {
    res.status(502).json({ error: `War Room save failed: ${e.message}` });
  }
});

export default router;
