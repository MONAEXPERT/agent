// MCP transport — stdio JSON-RPC server over the tool registry.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-mcp-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
fs.mkdirSync(process.env.MONA_WORKSPACE, { recursive: true });
process.env.MONA_POLICY = path.join(FAKE_HOME, '.remoteagent', 'policy.json');
fs.mkdirSync(path.dirname(process.env.MONA_POLICY), { recursive: true });
fs.writeFileSync(process.env.MONA_POLICY, JSON.stringify({ version: 1, tools: { shell: 'deny', net: 'deny' } }));

const { tools: allowRegistry } = await import('../src/tools/index.js');
const { createMcpServer, argsToSchema, toolToMcpSchema, runMcpHttpServer } = await import('../src/transport/mcp.js');
const allowServer = createMcpServer({ registry: allowRegistry });

/** Raw HTTP request with full header control (for Host/Origin cases). */
function rawRequest({ port, path = '/', method = 'GET', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: data, json });
      });
    });
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

describe('MCP transport', () => {
  it('argsToSchema converts remoteagent freeform args to JSON Schema', () => {
    const s = argsToSchema({ cmd: 'string — the command', verbose: 'boolean — flag' });
    assert.equal(s.type, 'object');
    assert.deepEqual(s.properties.cmd, { type: 'string', description: 'the command' });
    assert.deepEqual(s.properties.verbose, { type: 'boolean', description: 'flag' });
    assert.deepEqual(s.required, []);
  });

  it('initialize handshake reports protocol + server info', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.id, 1);
    assert.equal(r.result.protocolVersion, '2024-11-05');
    assert.equal(r.result.serverInfo.name, 'remoteagent');
    assert.match(r.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.ok(r.result.capabilities.tools);
  });

  it('tools/list returns schema-typed builtins', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = r.result.tools.map((t) => t.name);
    assert.ok(names.includes('sysinfo'));
    assert.ok(names.includes('files'));
    assert.ok(names.includes('jobs'));
    assert.ok(names.includes('workflow'));
    const shell = r.result.tools.find((t) => t.name === 'shell');
    assert.equal(shell.inputSchema.type, 'object');
  });

  it('tools/call executes an allowed tool', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sysinfo', arguments: {} } });
    assert.equal(r.id, 3);
    assert.equal(r.result.content.length, 1);
    assert.equal(r.result.content[0].type, 'text');
    assert.ok(!r.result.isError);
    const out = JSON.parse(r.result.content[0].text);
    assert.ok(out.platform !== undefined && out.detail !== undefined, JSON.stringify(out));
  });

  it('tools/call respects the local policy gate (shell denied)', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shell', arguments: { cmd: 'echo hi' } } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /denied by policy/);
  });

  it('tools/call on an unknown tool errors with available list', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope.tool', arguments: {} } });
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /Unknown tool/);
  });

  it('unknown method → -32601, malformed → -32700, notifications get no reply', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 6, method: 'resources/list' });
    assert.equal(r.error.code, -32601);
    const p = await allowServer.handle({ not: 'rpc' });
    assert.equal(p.error.code, -32700);
    const n = await allowServer.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(n, null);
  });

  it('ping round-trips', async () => {
    const r = await allowServer.handle({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual(r.result, {});
  });

  it('toolToMcpSchema shapes a plugin-style descriptor', () => {
    const s = toolToMcpSchema({ name: 'fs.read', description: 'read', args: { path: 'string — path' } });
    assert.equal(s.name, 'fs.read');
    assert.equal(s.inputSchema.properties.path.type, 'string');
  });

  it('HTTP transport authenticates with a bearer token and host whitelist', async () => {
    const port = 4398;
    const stop = await runMcpHttpServer({ registry: allowRegistry, port });
    try {
      const token = fs.readFileSync(path.join(FAKE_HOME, '.remoteagent', 'mcp-token'), 'utf8').trim();
      assert.ok(token.length >= 32, 'token must be generated and persisted');

      // No token → 401.
      const noToken = await rawRequest({
        port, path: '/mcp', method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(noToken.status, 401);

      // Wrong Host → 403 (DNS rebinding).
      const badHost = await rawRequest({
        port, path: '/mcp', method: 'POST',
        headers: { host: `evil.example:${port}`, authorization: `Bearer ${token}` },
        body: '{}',
      });
      assert.equal(badHost.status, 403);

      // Browser Origin → 403 even with a valid token.
      const withOrigin = await rawRequest({
        port, path: '/mcp', method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: '{}',
      });
      assert.equal(withOrigin.status, 403);

      // /healthz stays token-free and information-free.
      const hz = await rawRequest({ port, path: '/healthz' });
      assert.equal(hz.status, 200);
      assert.deepEqual(hz.json, { ok: true });

      // Valid token + correct host → normal JSON-RPC result.
      const ok = await rawRequest({
        port, path: '/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list' }),
      });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.id, 100);
      assert.ok(Array.isArray(ok.json.result.tools));
      assert.ok(ok.json.result.tools.some((t) => t.name === 'sysinfo'));

      // Malformed JSON with a valid token → parse error.
      const bad = await rawRequest({
        port, path: '/mcp', method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: 'not json',
      });
      assert.equal(bad.json.error.code, -32700);
    } finally {
      await stop();
    }
  });
});
