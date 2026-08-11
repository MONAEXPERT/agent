// Local GUI server. Serves the dashboard and bridges browser <-> agent + cloud.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { loadCreds } from '../config.js';
import { Agent } from '../agent.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 4319;

const html = readFileSync(join(__dirname, 'index.html'), 'utf8');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(html);
  } else if (req.url === '/api/status') {
    const c = loadCreds();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ loggedIn: !!c?.apiKey, agentId: c?.agentId || null }));
  } else {
    res.writeHead(404); res.end('not found');
  }
});

const wss = new WebSocketServer({ server });
wss.on('connection', (client) => {
  const creds = loadCreds();
  if (!creds?.apiKey) {
    client.send(JSON.stringify({ type: 'error', data: 'Not logged in. Run: mona-agent login' }));
    return;
  }
  const agent = new Agent(creds);
  // Mirror telemetry to the browser dashboard.
  const origSend = agent.telemetry.send.bind(agent.telemetry);
  agent.telemetry.send = (type, data) => {
    origSend(type, data);
    if (client.readyState === 1) client.send(JSON.stringify({ type, data, ts: Date.now() }));
  };

  client.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'run' && msg.task) {
        await agent.run(msg.task, (delta) =>
          client.readyState === 1 && client.send(JSON.stringify({ type: 'token', data: delta })));
        client.readyState === 1 && client.send(JSON.stringify({ type: 'done' }));
      }
    } catch (e) {
      client.readyState === 1 && client.send(JSON.stringify({ type: 'error', data: e.message }));
    }
  });

  client.on('close', () => agent.close());
});

server.listen(PORT, () => {
  console.log(`\n  Mona Agent GUI  →  http://localhost:${PORT}\n`);
});
