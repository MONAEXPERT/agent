/**
 * Agent Connection Manager — WebSocket comms between platform and agents.
 *
 * Agents connect via WebSocket. The platform routes messages,
 * proxies LLM calls, and streams logs/status back to the dashboard.
 */
import { WebSocket } from 'ws';
import { LLMProxy } from './llm-proxy.js';

export class AgentConnection {
  constructor(wss, { vault, containers, audit }) {
    this.wss = wss;
    this.vault = vault;
    this.containers = containers;
    this.audit = audit;

    // Connected agents: agentId → { ws, name, model, pendingRequests }
    this.agents = new Map();

    // Dashboard clients: ws → Set<agentId>
    this.clients = new Map();

    wss.on('connection', (ws, req) => {
      const url = new URL(req.url, 'http://localhost');
      const clientType = url.searchParams.get('type'); // 'agent' or 'dashboard'
      const agentId = url.searchParams.get('agentId');

      if (clientType === 'agent' && agentId) {
        this._handleAgentConnection(ws, agentId);
      } else if (clientType === 'dashboard') {
        this._handleDashboardConnection(ws);
      } else {
        // Legacy/unknown — treat as agent
        this._handleAgentConnection(ws, agentId || 'unknown');
      }
    });
  }

  /**
   * Handle an agent connecting to the platform.
   */
  _handleAgentConnection(ws, agentId) {
    console.log(`  Agent connected: ${agentId}`);

    const state = {
      ws,
      name: agentId,
      model: 'unknown',
      pendingRequests: new Map() // requestId → { resolve, reject }
    };

    this.agents.set(agentId, state);

    // Register this agent for all dashboard clients
    for (const [_, subscribed] of this.clients) {
      subscribed.add(agentId);
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        await this._handleAgentMessage(agentId, state, msg);
      } catch (err) {
        console.error(`  Agent ${agentId} message error:`, err.message);
        this._send(ws, { type: 'error', error: err.message });
      }
    });

    ws.on('close', () => {
      console.log(`  Agent disconnected: ${agentId}`);
      this.agents.delete(agentId);
      this._broadcast({ type: 'agent:disconnected', agentId });
    });

    ws.on('error', (err) => {
      console.error(`  Agent ${agentId} WS error:`, err.message);
    });

    // Send welcome
    this._send(ws, { type: 'welcome', agentId, message: 'Connected to agent.mona.expert platform' });
  }

  /**
   * Handle a dashboard client connecting.
   */
  _handleDashboardConnection(ws) {
    console.log('  Dashboard client connected');
    this.clients.set(ws, new Set());

    // Send current agent list
    const agentIds = Array.from(this.agents.keys());
    this._send(ws, { type: 'agents:list', agents: agentIds });

    ws.on('close', () => {
      this.clients.delete(ws);
    });
  }

  /**
   * Handle a message from an agent.
   */
  async _handleAgentMessage(agentId, state, msg) {
    switch (msg.type) {
      case 'register': {
        state.name = msg.name || agentId;
        state.model = msg.model || 'unknown';
        console.log(`  Agent registered: ${state.name} (${state.model})`);
        this._broadcast({ type: 'agent:registered', agentId, name: state.name, model: state.model });
        break;
      }

      case 'llm:request': {
        // Agent wants to make an LLM call — proxy it through the platform
        try {
          const result = await LLMProxy.call(this.vault, {
            provider: msg.provider,
            model: msg.model,
            messages: msg.messages,
            temperature: msg.temperature,
            maxTokens: msg.maxTokens,
            keyId: msg.keyId
          });
          this._send(state.ws, {
            type: 'llm:response',
            requestId: msg.requestId,
            content: result.content,
            usage: result.usage,
            model: result.model,
            finishReason: result.finishReason
          });
          this.audit.record('llm:proxy', {
            agentId,
            provider: msg.provider || msg.model,
            messageCount: msg.messages?.length,
            usage: result.usage
          }, agentId);
        } catch (err) {
          this._send(state.ws, {
            type: 'llm:error',
            requestId: msg.requestId,
            error: err.message
          });
          this.audit.record('llm:proxy:error', {
            agentId,
            error: err.message
          }, agentId);
        }
        break;
      }

      case 'log': {
        // Agent is sending a log entry
        this._broadcast({
          type: 'agent:log',
          agentId,
          level: msg.level || 'info',
          message: msg.message,
          timestamp: msg.timestamp || new Date().toISOString()
        });
        this.audit.record('agent:log', {
          level: msg.level,
          message: msg.message
        }, agentId);
        break;
      }

      case 'status': {
        this._broadcast({
          type: 'agent:status',
          agentId,
          status: msg.status,
          details: msg.details || {}
        });
        break;
      }

      case 'tool:executed': {
        this.audit.record('tool:executed', {
          tool: msg.tool,
          args: msg.args,
          result: msg.result?.substring(0, 500)
        }, agentId);
        this._broadcast({
          type: 'agent:tool',
          agentId,
          tool: msg.tool,
          status: msg.status
        });
        break;
      }

      case 'chat:response': {
        // Agent response to a dashboard chat message
        this._broadcast({
          type: 'agent:chat',
          agentId,
          message: msg.message,
          requestId: msg.requestId
        });
        break;
      }

      case 'error': {
        console.error(`  Agent ${agentId} error:`, msg.error);
        this._broadcast({ type: 'agent:error', agentId, error: msg.error });
        this.audit.record('agent:error', { error: msg.error }, agentId);
        break;
      }

      default:
        console.log(`  Agent ${agentId} unknown message type: ${msg.type}`);
    }
  }

  /**
   * Send a chat message to an agent and wait for response.
   */
  async sendMessage(agentId, message) {
    const state = this.agents.get(agentId);
    if (!state) throw new Error(`Agent ${agentId} not connected`);

    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pendingRequests.delete(requestId);
        reject(new Error('Agent response timeout'));
      }, 120_000);

      state.pendingRequests.set(requestId, { resolve, reject, timeout });

      this._send(state.ws, {
        type: 'chat',
        requestId,
        message
      });

      // Listen for response
      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'chat:response' && msg.requestId === requestId) {
            clearTimeout(timeout);
            state.pendingRequests.delete(requestId);
            state.ws.removeListener('message', handler);
            resolve(msg.message);
          }
        } catch { /* ignore parse errors */ }
      };

      state.ws.on('message', handler);
    });
  }

  /**
   * Broadcast a message to all dashboard clients.
   */
  _broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const [ws] of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    }
  }

  /**
   * Send a message to a specific WebSocket.
   */
  _send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}
