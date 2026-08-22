import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSecureEndpoint, assertSecureWs, matchesAllowlist, DEFAULT_CLOUD_HOSTS, inspectEndpoint } from '../src/index.mjs';

// The endpoint guard is the single choke point for where the daemon dials.
// These tests pin the security contract: TLS off-loopback, allowlist by
// default, no credentials in URLs, no raw IPs, plaintext only on loopback.

test('default hosts are allowed over https', () => {
  assert.equal(assertSecureEndpoint('https://api.remoteagent.online'), 'https://api.remoteagent.online');
  assert.equal(assertSecureEndpoint('https://remoteagent.online/'), 'https://remoteagent.online');
  assert.equal(assertSecureEndpoint('https://app.remoteagent.online'), 'https://app.remoteagent.online');
});

test('trailing slash is normalized away', () => {
  assert.equal(assertSecureEndpoint('https://api.remoteagent.online/'), 'https://api.remoteagent.online');
});

test('plaintext http is rejected off-loopback', () => {
  assert.throws(() => assertSecureEndpoint('http://api.remoteagent.online'), /insecure/);
  assert.throws(() => assertSecureEndpoint('http://remoteagent.online'), /insecure/);
});

test('wss is accepted for allowlisted hosts, ws rejected off-loopback', () => {
  assert.equal(assertSecureWs('wss://api.remoteagent.online/ws?role=device'), 'wss://api.remoteagent.online/ws?role=device');
  assert.throws(() => assertSecureWs('ws://api.remoteagent.online/ws'), /insecure/);
});

test('loopback plaintext is allowed for the self-hosted Docker platform', () => {
  assert.equal(assertSecureEndpoint('http://127.0.0.1:4300'), 'http://127.0.0.1:4300');
  assert.equal(assertSecureEndpoint('http://localhost:4300/'), 'http://localhost:4300');
  assert.equal(assertSecureWs('ws://127.0.0.1:4300/ws'), 'ws://127.0.0.1:4300/ws');
  assert.equal(assertSecureWs('ws://localhost:4300/ws?type=agent'), 'ws://localhost:4300/ws?type=agent');
  assert.equal(assertSecureEndpoint('http://[::1]:4300'), 'http://[::1]:4300');
});

test('loopback plaintext can be disabled entirely', () => {
  assert.throws(() => assertSecureEndpoint('http://127.0.0.1:4300', { allowLoopback: false }), /insecure/);
});

test('unknown domains are rejected unless explicitly allowlisted', () => {
  assert.throws(() => assertSecureEndpoint('https://evil.example'), /allowlist/);
  assert.throws(() => assertSecureEndpoint('https://notremoteagent.online'), /allowlist/);
  // explicit opt-in (RA_CLOUD_ALLOWLIST semantics)
  assert.equal(
    assertSecureEndpoint('https://gw.corp.internal', { allowlist: ['*.corp.internal'] }),
    'https://gw.corp.internal'
  );
  assert.equal(
    assertSecureEndpoint('https://selfhost.example', { allowlist: ['selfhost.example'] }),
    'https://selfhost.example'
  );
});

test('credentials in the URL are rejected', () => {
  assert.throws(() => assertSecureEndpoint('https://user:pass@api.remoteagent.online'), /credentials/);
});

test('raw IP literals are rejected except loopback', () => {
  assert.throws(() => assertSecureEndpoint('https://10.0.0.5'), /raw IP/);
  assert.throws(() => assertSecureEndpoint('https://172.16.0.1'), /raw IP/);
});

test('non-http(s) protocols are rejected', () => {
  assert.throws(() => assertSecureEndpoint('ftp://api.remoteagent.online'), /protocol/);
  assert.throws(() => assertSecureEndpoint('file:///etc/passwd'), /protocol/);
  assert.throws(() => assertSecureEndpoint('javascript:alert(1)'), /protocol/);
});

test('garbage input is rejected', () => {
  assert.throws(() => assertSecureEndpoint('not a url'), /invalid/);
  assert.throws(() => assertSecureEndpoint(''), /invalid/);
});

test('websocket guard rejects http-family URLs and vice versa', () => {
  assert.throws(() => assertSecureWs('https://api.remoteagent.online'), /websocket/);
  assert.throws(() => assertSecureEndpoint('wss://api.remoteagent.online'), /cloud endpoint/);
});

test('matchesAllowlist: exact, wildcard, and negative cases', () => {
  assert.equal(matchesAllowlist('remoteagent.online', DEFAULT_CLOUD_HOSTS), true);
  assert.equal(matchesAllowlist('api.remoteagent.online', DEFAULT_CLOUD_HOSTS), true);
  assert.equal(matchesAllowlist('app.remoteagent.online', DEFAULT_CLOUD_HOSTS), true);
  assert.equal(matchesAllowlist('evilremoteagent.online', DEFAULT_CLOUD_HOSTS), false);
  assert.equal(matchesAllowlist('remoteagent.online.evil.example', DEFAULT_CLOUD_HOSTS), false);
  assert.equal(matchesAllowlist('localhost', DEFAULT_CLOUD_HOSTS), false);
});

test('inspectEndpoint reports loopback and protocol facts', () => {
  const p = inspectEndpoint('http://127.0.0.1:4300');
  assert.equal(p.loopback, true);
  assert.equal(p.protocol, 'http:');
  const q = inspectEndpoint('https://api.remoteagent.online');
  assert.equal(q.loopback, false);
  assert.equal(q.protocol, 'https:');
});
