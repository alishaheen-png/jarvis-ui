let state = {
  agents: [],
  queue: [],
  pending: 0,
  health: null,
};

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || data.detail || 'request failed');
  return data;
}

async function refreshWarroom() {
  try {
    const [agents, queue, health] = await Promise.all([
      fetchJson('/api/warroom/agents'),
      fetchJson('/api/warroom/queue'),
      fetchJson('/api/warroom/health'),
    ]);
    state = {
      agents: agents.agents || [],
      queue: queue.items || [],
      pending: queue.pending || 0,
      health,
    };
    render();
  } catch (err) {
    console.error('[WARROOM]', err);
    render(err.message);
  }
}

function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function statusClass(agent) {
  if (!agent.engaged) return 'paused';
  return agent.runtime_status === 'running' ? 'running' : 'idle';
}

function render(error) {
  const el = document.getElementById('rtab-agents');
  if (!el) return;

  const running = state.agents.filter(a => a.runtime_status === 'running').length;
  const enabled = state.agents.filter(a => a.engaged).length;

  el.innerHTML = `
    <div class="warroom-summary">
      <div class="warroom-stat"><span class="warroom-stat-label">AGENTS</span><span class="warroom-stat-value">${state.agents.length}</span></div>
      <div class="warroom-stat"><span class="warroom-stat-label">RUNNING</span><span class="warroom-stat-value">${running}</span></div>
      <div class="warroom-stat"><span class="warroom-stat-label">PENDING</span><span class="warroom-stat-value">${state.pending}</span></div>
    </div>

    <div class="warroom-toolbar">
      <div class="warroom-health">HEALTH: ${state.health?.status || state.health?.overall || 'LIVE'} · ENABLED ${enabled}/${state.agents.length}</div>
      <button class="warroom-refresh" id="warroom-refresh">REFRESH</button>
    </div>

    ${error ? `<div class="warroom-empty">WAR ROOM ERROR: ${error}</div>` : ''}

    <div class="warroom-section-title">AGENT GRID</div>
    <div class="warroom-list">
      ${state.agents.length ? state.agents.map(agent => `
        <div class="warroom-card" data-agent-id="${agent.id}">
          <div class="warroom-card-header">
            <span class="warroom-agent-name">${agent.name}</span>
            <span class="warroom-agent-status ${statusClass(agent)}">${(agent.runtime_status || (agent.engaged ? 'idle' : 'paused')).toUpperCase()}</span>
          </div>
          <div class="warroom-meta">TRUST ${agent.trust ?? agent.trust_score ?? '—'} · LAST ${fmtTime(agent.last_run)}</div>
          <div class="warroom-meta">${agent.role || agent.description || ''}</div>
          <div class="warroom-actions">
            <button class="warroom-action-btn" data-action="fire">FIRE</button>
            <button class="warroom-action-btn" data-action="toggle">${agent.engaged ? 'PAUSE' : 'ENABLE'}</button>
          </div>
        </div>
      `).join('') : '<div class="warroom-empty">NO AGENTS LOADED</div>'}
    </div>

    <div class="warroom-section-title">APPROVAL QUEUE</div>
    <div class="warroom-queue-list">
      ${state.queue.filter(item => item.status === 'pending').length
        ? state.queue.filter(item => item.status === 'pending').map(item => `
          <div class="warroom-queue-item" data-queue-id="${item.id}">
            <div class="warroom-queue-head">
              <span class="warroom-queue-agent">${item.agent_name || item.agent_id}</span>
              <span class="warroom-queue-meta">${fmtTime(item.created_at)}</span>
            </div>
            <div class="warroom-queue-preview">${String(item.output || '').slice(0, 180)}</div>
            <div class="warroom-queue-actions">
              <button class="warroom-queue-btn" data-action="approve">APPROVE</button>
              <button class="warroom-queue-btn reject" data-action="reject">REJECT</button>
            </div>
          </div>
        `).join('')
        : '<div class="warroom-empty">NO PENDING APPROVALS</div>'}
    </div>
  `;

  bindEvents(el);
}

function bindEvents(el) {
  el.querySelector('#warroom-refresh')?.addEventListener('click', refreshWarroom);

  el.querySelectorAll('[data-agent-id]').forEach(card => {
    const agentId = card.dataset.agentId;
    card.querySelector('[data-action="fire"]')?.addEventListener('click', async () => {
      await fetchJson(`/api/warroom/agents/${encodeURIComponent(agentId)}/fire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      refreshWarroom();
    });
    card.querySelector('[data-action="toggle"]')?.addEventListener('click', async () => {
      await fetchJson(`/api/warroom/agents/${encodeURIComponent(agentId)}/toggle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      refreshWarroom();
    });
  });

  el.querySelectorAll('[data-queue-id]').forEach(item => {
    const id = item.dataset.queueId;
    item.querySelector('[data-action="approve"]')?.addEventListener('click', async () => {
      await fetchJson(`/api/warroom/queue/${encodeURIComponent(id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      refreshWarroom();
    });
    item.querySelector('[data-action="reject"]')?.addEventListener('click', async () => {
      await fetchJson(`/api/warroom/queue/${encodeURIComponent(id)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Rejected from JARVIS HUD' }),
      });
      refreshWarroom();
    });
  });
}

export function initWarroom() {
  refreshWarroom();
  setInterval(refreshWarroom, 15000);
}
