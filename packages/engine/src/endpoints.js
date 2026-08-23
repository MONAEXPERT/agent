// RemoteAgent endpoint guard — the daemon dials out to exactly ONE
// trusted surface, and this module is the single choke point for that.
//
// Rules (enforced whenever the daemon builds a cloud URL):
//   1. TLS required: https:/wss: for every non-loopback host. Plaintext
//      http:/ws: is accepted ONLY on loopback (self-hosted Docker platform
//      and local development). There is no flag to downgrade this.
//   2. Host allowlist: by default only "remoteagent.online" and its
//      subdomains (*.remoteagent.online). Anything else must be named
//      explicitly through RA_CLOUD_ALLOWLIST (comma-separated hosts or
//      *.domain wildcards). A stray env var can never silently repoint
//      the device at a third-party host.
//   3. No credentials in URLs: userinfo (https://user:pass@host) is
//      rejected outright. The API key travels in the Authorization
//      header only — never in a URL, a log line, or an error message.
//   4. Raw IP literals are rejected except loopback. Pinning a fleet to
//      an IP by accident bypasses DNS and breaks auditability; DNS names
//      are verifiable against the allowlist.
//
// Fail-closed: violations throw immediately, before any network bytes
// leave the device. A daemon that cannot trust its endpoint refuses to
// start rather than connect insecurely.

export const DEFAULT_CLOUD_HOSTS = Object.freeze(['remoteagent.online', '*.remoteagent.online']);

const LOOPBACK_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);
const LOOPBACK_V6 = new Set(['::1', '0:0:0:0:0:0:0:1']);

function bareHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

function isLoopbackHostname(hostname) {
  const h = bareHost(hostname);
  return LOOPBACK_HOSTNAMES.has(h) || h.startsWith('127.') || LOOPBACK_V6.has(h);
}

function isIpLiteral(hostname) {
  const h = bareHost(hostname);
  if (h.includes(':')) return true; // IPv6
  const parts = h.split('.');
  return parts.length === 4 && parts.every((p) => /^[0-9]+$/.test(p));
}

/** Match a hostname against an allowlist entry (exact or *.suffix). */
export function matchesAllowlist(hostname, allowlist) {
  const h = bareHost(hostname);
  for (const entry of allowlist) {
    const rule = String(entry).trim().toLowerCase();
    if (!rule) continue;
    if (rule === h) return true;
    if (rule.startsWith('*.')) {
      const suffix = rule.slice(1); // ".remoteagent.online"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    }
  }
  return false;
}

function parseEndpoint(raw, opts = {}) {
  const what = opts.what || 'endpoint';
  const allowlist = opts.allowlist || DEFAULT_CLOUD_HOSTS;
  const allowLoopback = opts.allowLoopback !== false;
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    throw new Error('invalid ' + what + ' URL: ' + JSON.stringify(raw));
  }

  const protocol = url.protocol;
  const hostname = url.hostname;
  const loopback = isLoopbackHostname(hostname);
  const isTls = protocol === 'https:' || protocol === 'wss:';
  const isPlain = protocol === 'http:' || protocol === 'ws:';

  if (!isTls && !isPlain) {
    throw new Error('unsupported ' + what + ' protocol "' + protocol + '" — only https/wss (and http/ws on loopback) are allowed');
  }
  if (isPlain && (!loopback || !allowLoopback)) {
    throw new Error('insecure ' + what + ' "' + protocol + '" rejected for host "' + hostname + '" — the RemoteAgent client requires TLS on every non-loopback connection (use https/wss)');
  }
  if (url.username || url.password) {
    throw new Error(what + ' URL must not contain credentials — send the API key in the Authorization header');
  }
  if (!loopback && isIpLiteral(hostname)) {
    throw new Error(what + ' host "' + hostname + '" is a raw IP address — use a DNS name from the allowlist instead');
  }
  if (!loopback && !matchesAllowlist(hostname, allowlist)) {
    throw new Error(what + ' host "' + hostname + '" is not on the allowlist (' + allowlist.join(', ') + ') — add it explicitly via RA_CLOUD_ALLOWLIST');
  }
  return { url, loopback, hostname, protocol };
}

/**
 * Validate an HTTP(S) cloud endpoint. Returns the normalized URL string.
 * Throws on any violation. loopback http is allowed (self-hosted Docker).
 */
export function assertSecureEndpoint(raw, opts) {
  const p = parseEndpoint(raw, Object.assign({ what: 'cloud endpoint' }, opts));
  if (p.protocol !== 'https:' && p.protocol !== 'http:') {
    throw new Error('cloud endpoint must be http(s); got "' + p.protocol + '" — use assertSecureWs for websocket URLs');
  }
  const href = p.url.href;
  return href.endsWith('/') ? href.slice(0, -1) : href;
}

/**
 * Validate a WebSocket endpoint. wss required off-loopback; ws allowed on
 * loopback only. Returns the normalized URL string.
 */
export function assertSecureWs(raw, opts) {
  const p = parseEndpoint(raw, Object.assign({ what: 'websocket' }, opts));
  if (p.protocol !== 'wss:' && p.protocol !== 'ws:') {
    throw new Error('websocket endpoint must be ws(s); got "' + p.protocol + '"');
  }
  return p.url.href;
}

/** Parse + validate, returning the parsed URL plus loopback/allowlist facts. */
export function inspectEndpoint(raw, opts) {
  return parseEndpoint(raw, opts);
}
