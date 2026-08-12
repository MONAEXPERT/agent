/**
 * agent.mona.expert — Dashboard SPA
 *
 * Single-page app for managing agents, API keys, audit logs.
 * Communicates with the platform via REST API + WebSocket.
 */

const API = '/api';
let ws = null;
let currentPage = 'dashboard';
let chatAgentId = null;

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  setupForms();
  connectWS();
  loadPage('dashboard');
});

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const page = item.dataset.page;
      loadPage(page);
    });
  });
}

function setupForms() {
  // Create agent
  document.getElementById('create-agent-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const tools = Array.from(form.querySelectorAll('input[name="tools"]:checked')).map(cb => cb.value);
    const data = {
      name: form.name.value,
      model: form.model.value,
      systemPrompt: form.systemPrompt.value,
      tools
    };

    try {
      const res = await fetch(`${API}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error((await res.json()).error);
      hideCreateAgent();
      form.reset();
      loadAgents();
    } catch (err) {
      alert(`Failed to create agent: ${err.message}`);
    }
  });

  // Add key
  document.getElementById('add-key-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const data = {
      provider: form.provider.value,
      label: form.label.value || `${form.provider.value}-key`,
      key: form.key.value
    };

    try {
      const res = await fetch(`${API}/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error((await res.json()).error);
      hideAddKey();
      form.reset();
      loadKeys();
    } catch (err) {
      alert(`Failed to add key: ${err.message}`);
    }
  });
}

// ── WebSocket ──────────────────────────────────────────────────────
function connectWS() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}/ws?type=dashboard`;

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    updateStatus('connected', 'Connected');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWSMessage(msg);
    } catch (err) {
      console.error('WS parse error:', err);
    }
  };

  ws.onclose = () => {
    updateStatus('disconnected', 'Disconnected');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => {
    updateStatus('disconnected', 'Connection error');
  };
}

function handleWSMessage(msg) {
  switch (msg.type) {
    case 'agent:log':
      if (currentPage === 'dashboard') loadDashboard();
      break;
    case 'agent:registered':
    case 'agent:disconnected':
      if (currentPage === 'dashboard') loadDashboard();
      if (currentPage === 'agents') loadAgents();
      break;
    case 'agent:status':
      if (currentPage === 'dashboard') loadDashboard();
      if (currentPage === 'agents') loadAgents();
      break;
    case 'agent:chat':
      if (chatAgentId === msg.agentId) {
        addChatMessage('agent', msg.message);
      }
      break;
    case 'agent:error':
      if (chatAgentId === msg.agentId) {
        addChatMessage('error', msg.error);
      }
      break;
  }
}

function updateStatus(status, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + status;
  label.textContent = text;
}

// ── Navigation ─────────────────────────────────────────────────────
function loadPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  switch (page) {
    case 'dashboard': loadDashboard(); break;
    case 'agents': loadAgents(); break;
    case 'keys': loadKeys(); break;
    case 'audit': loadAudit(); break;
    case 'settings': loadSettings(); break;
  }
}

// ── Dashboard ──────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const res = await fetch(`${API}/system`);
    const sys = await res.json();

    document.getElementById('stat-agents').textContent = sys.agentsRunning || 0;
    document.getElementById('stat-total').textContent = sys.agentsTotal || 0;
    document.getElementById('stat-keys').textContent = sys.keysStored || 0;

    const uptime = sys.uptime ? formatUptime(sys.uptime) : '—';
    document.getElementById('stat-uptime').textContent = uptime;

    // Recent activity
    const auditRes = await fetch(`${API}/audit?limit=10`);
    const audit = await auditRes.json();
    const container = document.getElementById('recent-activity');
    if (audit.length === 0) {
      container.innerHTML = '<p class="muted">No activity yet. Create an agent or add an API key to get started.</p>';
    } else {
      container.innerHTML = audit.map(entry => `
        <div class="activity-item">
          <span class="activity-icon">${eventIcon(entry.type)}</span>
          <span>${formatEvent(entry)}</span>
          <span style="margin-left:auto;font-size:11px;color:var(--fg2)">${timeAgo(entry.timestamp)}</span>
        </div>
      `).join('');
    }
  } catch (err) {
    console.error('Dashboard error:', err);
  }
}

// ── Agents ─────────────────────────────────────────────────────────
async function loadAgents() {
  try {
    const res = await fetch(`${API}/agents`);
    const agents = await res.json();
    const container = document.getElementById('agents-list');

    if (agents.length === 0) {
      container.innerHTML = '<p class="muted">No agents yet. Create your first agent to get started.</p>';
      return;
    }

    container.innerHTML = agents.map(agent => `
      <div class="agent-card">
        <div class="agent-card-header">
          <div>
            <div class="agent-name">${esc(agent.name)}</div>
            <div class="agent-model">${esc(agent.model)}</div>
          </div>
          <span class="agent-status ${agent.status}">${agent.status}</span>
        </div>
        <div class="agent-tools">
          ${(agent.tools || []).map(t => `<span class="agent-tool-tag">${t}</span>`).join('')}
        </div>
        <div class="agent-actions">
          ${agent.status === 'stopped' || agent.status === 'created'
            ? `<button class="btn btn-success btn-sm" onclick="startAgent('${agent.id}')">▶ Start</button>`
            : `<button class="btn btn-secondary btn-sm" onclick="stopAgent('${agent.id}')">■ Stop</button>`
          }
          <button class="btn btn-primary btn-sm" onclick="openChat('${agent.id}', '${esc(agent.name)}')">💬 Chat</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAgent('${agent.id}')">🗑</button>
        </div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Agents error:', err);
  }
}

async function startAgent(id) {
  await fetch(`${API}/agents/${id}/start`, { method: 'POST' });
  loadAgents();
}

async function stopAgent(id) {
  await fetch(`${API}/agents/${id}/stop`, { method: 'POST' });
  loadAgents();
}

async function deleteAgent(id) {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  await fetch(`${API}/agents/${id}`, { method: 'DELETE' });
  loadAgents();
}

function showCreateAgent() {
  document.getElementById('create-agent-modal').classList.add('open');
}

function hideCreateAgent() {
  document.getElementById('create-agent-modal').classList.remove('open');
}

// ── Chat ───────────────────────────────────────────────────────────
function openChat(agentId, name) {
  chatAgentId = agentId;
  document.getElementById('chat-title').textContent = `💬 ${name}`;
  document.getElementById('chat-messages').innerHTML = '';
  document.getElementById('chat-panel').classList.add('open');
  document.getElementById('chat-input').focus();
}

function closeChat() {
  chatAgentId = null;
  document.getElementById('chat-panel').classList.remove('open');
}

async function sendChat() {
  const input = document.getElementById('chat-input');
  const message = input.value.trim();
  if (!message || !chatAgentId) return;

  input.value = '';
  addChatMessage('user', message);

  try {
    const res = await fetch(`${API}/agents/${chatAgentId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (data.error) {
      addChatMessage('error', data.error);
    } else if (data.reply) {
      addChatMessage('agent', data.reply);
    }
  } catch (err) {
    addChatMessage('error', `Connection error: ${err.message}`);
  }
}

function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Keys ───────────────────────────────────────────────────────────
async function loadKeys() {
  try {
    const res = await fetch(`${API}/keys`);
    const keys = await res.json();
    const container = document.getElementById('keys-list');

    if (keys.length === 0) {
      container.innerHTML = '<p class="muted">No API keys stored. Add your first key to enable agents.</p>';
      return;
    }

    container.innerHTML = keys.map(key => `
      <div class="key-card">
        <div class="key-info">
          <div class="key-provider">${esc(key.provider)}</div>
          <div class="key-label">${esc(key.label)}</div>
        </div>
        <div class="key-masked">${esc(key.masked)}</div>
        <button class="btn btn-danger btn-sm" onclick="deleteKey('${key.id}')">Remove</button>
      </div>
    `).join('');
  } catch (err) {
    console.error('Keys error:', err);
  }
}

async function deleteKey(id) {
  if (!confirm('Remove this API key? Agents using it will fail.')) return;
  await fetch(`${API}/keys/${id}`, { method: 'DELETE' });
  loadKeys();
}

function showAddKey() {
  document.getElementById('add-key-modal').classList.add('open');
}

function hideAddKey() {
  document.getElementById('add-key-modal').classList.remove('open');
}

// ── Audit ──────────────────────────────────────────────────────────
async function loadAudit() {
  try {
    const type = document.getElementById('audit-filter-type').value;
    const url = type ? `${API}/audit?type=${encodeURIComponent(type)}&limit=100` : `${API}/audit?limit=100`;
    const res = await fetch(url);
    const entries = await res.json();
    const container = document.getElementById('audit-list');

    if (entries.length === 0) {
      container.innerHTML = '<p class="muted">No audit entries found.</p>';
      return;
    }

    container.innerHTML = entries.map(entry => `
      <div class="audit-entry">
        <span class="audit-ts">${entry.timestamp}</span>
        <span class="audit-type ${eventTypeClass(entry.type)}">${entry.type}</span>
        <span>${formatEvent(entry)}</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Audit error:', err);
  }
}

// ── Settings ───────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const res = await fetch(`${API}/system`);
    const sys = await res.json();

    document.getElementById('setting-docker').textContent = sys.docker?.available
      ? `✅ Available (${sys.docker.containers || 0} containers)`
      : '❌ Not running — agents run as local processes';

    document.getElementById('setting-url').textContent = location.origin;
    document.getElementById('setting-data-dir').textContent = 'data/ (SQLite)';
  } catch (err) {
    console.error('Settings error:', err);
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

function timeAgo(ts) {
  const diff = (Date.now() - new Date(ts + 'Z').getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function eventIcon(type) {
  if (type.startsWith('llm:')) return '🤖';
  if (type.startsWith('agent:')) return '🤖';
  if (type.startsWith('key:')) return '🔑';
  if (type.startsWith('tool:')) return '🔧';
  return '📋';
}

function eventTypeClass(type) {
  if (type.startsWith('llm:')) return 'llm';
  if (type.startsWith('agent:')) return 'agent';
  if (type.startsWith('key:')) return 'key';
  if (type.startsWith('tool:')) return 'tool';
  if (type.includes('error')) return 'error';
  return '';
}

function formatEvent(entry) {
  const d = entry.data || {};
  switch (entry.type) {
    case 'llm:call':
      return `LLM call to ${d.provider}/${d.model || ''} — ${d.messageCount || 0} messages, ${d.tokenUsage?.total || 0} tokens`;
    case 'llm:proxy':
      return `LLM proxied for agent ${d.agentId} — ${d.messageCount || 0} messages`;
    case 'llm:proxy:error':
      return `LLM proxy error for ${d.agentId}: ${d.error}`;
    case 'agent:create':
      return `Agent "${d.name}" created`;
    case 'agent:start':
      return `Agent ${d.id} started`;
    case 'agent:stop':
      return `Agent ${d.id} stopped`;
    case 'agent:delete':
      return `Agent ${d.id} deleted`;
    case 'agent:log':
      return `[${d.level}] ${d.message}`;
    case 'agent:error':
      return `Error: ${d.error}`;
    case 'tool:executed':
      return `Tool "${d.tool}" executed`;
    case 'key:create':
      return `API key added for ${d.provider}`;
    case 'key:delete':
      return `API key removed (${d.id})`;
    default:
      return JSON.stringify(d).substring(0, 100);
  }
}
