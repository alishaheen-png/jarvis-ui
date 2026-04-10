import { Router } from 'express';
import { Readable } from 'stream';

const router = Router();
const WARROOM_URL = process.env.WARROOM_URL || 'http://127.0.0.1:8888';

function buildTarget(pathname, req) {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return `${WARROOM_URL}${pathname}${query}`;
}

async function proxy(req, res, pathname, { forceJson = false } = {}) {
  try {
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!value) continue;
      const lower = key.toLowerCase();
      if (['host', 'connection', 'content-length'].includes(lower)) continue;
      headers[key] = value;
    }

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      if (forceJson || req.headers['content-type']?.includes('application/json')) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(req.body || {});
      }
    }

    const upstream = await fetch(buildTarget(pathname, req), {
      method: req.method,
      headers,
      body,
      duplex: body ? 'half' : undefined,
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'transfer-encoding') return;
      res.setHeader(key, value);
    });

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (error) {
    res.status(502).json({ error: `War Room proxy failed: ${error.message}` });
  }
}

router.get('/warroom/agents', (req, res) => proxy(req, res, '/api/agents'));
router.post('/warroom/agents/:id/fire', (req, res) => proxy(req, res, `/api/agents/${encodeURIComponent(req.params.id)}/fire`, { forceJson: true }));
router.post('/warroom/agents/:id/toggle', (req, res) => proxy(req, res, `/api/agents/${encodeURIComponent(req.params.id)}/toggle`, { forceJson: true }));
router.get('/warroom/queue', (req, res) => proxy(req, res, '/api/queue'));
router.post('/warroom/queue/:id/approve', (req, res) => proxy(req, res, `/api/queue/${encodeURIComponent(req.params.id)}/approve`, { forceJson: true }));
router.post('/warroom/queue/:id/reject', (req, res) => proxy(req, res, `/api/queue/${encodeURIComponent(req.params.id)}/reject`, { forceJson: true }));
router.get('/warroom/health', (req, res) => proxy(req, res, '/api/health'));
router.post('/warroom/health/run', (req, res) => proxy(req, res, '/api/health/run', { forceJson: true }));
router.get('/warroom/chains', (req, res) => proxy(req, res, '/api/chains'));
router.post('/warroom/chains/:id/run', (req, res) => proxy(req, res, `/api/chains/${encodeURIComponent(req.params.id)}/run`, { forceJson: true }));
router.get('/warroom/logs', (req, res) => proxy(req, res, '/api/logs'));
router.get('/warroom/pipeline', (req, res) => proxy(req, res, '/api/pipeline'));
router.get('/warroom/status', (req, res) => proxy(req, res, '/api/status'));

router.all('/warroom/*splat', (req, res) => {
  const suffix = req.params.splat ? `/${req.params.splat}` : '';
  return proxy(req, res, `/api${suffix}`);
});

export default router;
