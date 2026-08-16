// Policy-as-code: user-editable rules that govern what the agent may do.
//
// Loaded from MONA_POLICY (path to a JSON file) or ~/.mona-agent/policy.json.
// If neither exists, a safe default policy applies (allow known tools,
// block destructive shell patterns, require confirmation on dangerous ones).
//
// The control plane can NEVER modify policy. It is loaded from local disk
// only; remote policy updates are rejected outright. This file is the
// device-side authority — the cloud can only ever ask.
//
// Policy shape (all fields optional):
// {
//   "version": 1,
//   "tools":   { "shell": "confirm", "web": "deny", ... },   // allow | deny | confirm
//   "shell":   { "deny": ["pattern", ...],                   // extra blocked patterns
//                "approval": ["pattern", ...],               // patterns that need confirmation
//                "unsafe": false },                          // true = unrestricted argv shell
//   "rateLimits": { "shell": { "perMinute": 20 }, "*": { "perMinute": 300 } },
//   "budget":  { "dailyTokens": 500000, "dailyCostUsd": 2 }, // 0 = unlimited
//   "maxSteps": 12,
//   "audit":   true                                          // write decisions to audit log
// }
//
// Audit log: ~/.mona-agent/audit.jsonl (MONA_AUDIT to override). Hash-chained
// (h_n = sha256(h_{n-1} || entry)), append-only. Verify with
// `mona-agent audit verify`.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, appendFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_POLICY_PATH = process.env.MONA_POLICY || join(homedir(), '.mona-agent', 'policy.json');
const DEFAULT_AUDIT_PATH  = process.env.MONA_AUDIT  || join(homedir(), '.mona-agent', 'audit.jsonl');

// Destructive shell patterns that are always denied, regardless of policy.
const BASE_DENY = [
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\/s*$/i,
  /rm\s+(-[a-z]*[rf][a-z]*\s+)+\*\s*$/i,
  /mkfs\b/i,
  /dd\s+if=/i,
  /:\(\)\s*\{.*\}/,
  />\s*\/dev\/sd[a-z]/i,
  /chmod\s+777\s+\//i,
  /sudo\b/i,
  /shutdown\b|poweroff\b|reboot\b|halt\b/i,
  /curl\s+.*\|\s*(ba|z)?sh/i,
  /wget\s+.*\|\s*(ba|z)?sh/i,
  /format\s+[a-z]:/i,
  /del\s+\/f\s+\/s\s+[a-z]:\\/i,
  /rmdir\s+\/s\s+[a-z]:\\/i,
  /diskpart\b/i,
];

const KNOWN_TOOLS = new Set([
  'sysinfo', 'shell', 'files', 'net', 'apps', 'browser', 'web', 'memory', 'notify',
]);

const VALID_TIERS = new Set(['allow', 'deny', 'confirm']);

// ── Audit log (hash-chained, append-only) ─────────────────────────
let auditSeq = 0;
let auditPrev = '';

function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/** Append one audit entry. Never throws — auditing must not break tool calls. */
export function auditWrite(entry, path = DEFAULT_AUDIT_PATH) {
  try {
    if (auditSeq === 0) {
      // First write of this process: recover chain position from disk.
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
        if (raw.length) {
          const last = JSON.parse(raw[raw.length - 1]);
          auditSeq = Number(last.seq) || 0;
          auditPrev = last.hash || '';
        }
      } else {
        mkdirSync(dirname(path), { recursive: true });
      }
    }
    const line = JSON.stringify({
      seq: ++auditSeq,
      ts:  new Date().toISOString(),
      ...entry,
      prev: auditPrev,
    });
    const hash = sha256(line);
    const record = { ...JSON.parse(line), hash };
    appendFileSync(path, JSON.stringify(record) + '\n', { mode: 0o600 });
    auditPrev = hash;
  } catch { /* audit must never crash the agent */ }
}

/**
 * Verify the hash chain of an audit log. Returns { ok, checked, brokenAt }.
 * `checked` = number of entries verified; brokenAt = seq of first mismatch.
 */
export function auditVerify(path = DEFAULT_AUDIT_PATH) {
  try {
    if (!existsSync(path)) return { ok: true, checked: 0, brokenAt: null };
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    let prev = '';
    for (let i = 0; i < lines.length; i++) {
      let rec;
      try { rec = JSON.parse(lines[i]); } catch { return { ok: false, checked: i, brokenAt: i + 1, reason: 'corrupt JSON' }; }
      const expected = sha256(JSON.stringify({ seq: rec.seq, ts: rec.ts, ...stripHash(rec), prev: rec.prev }));
      if (rec.hash !== expected) return { ok: false, checked: i, brokenAt: rec.seq, reason: 'hash mismatch' };
      if (rec.prev !== prev)     return { ok: false, checked: i, brokenAt: rec.seq, reason: 'chain break' };
      prev = rec.hash;
    }
    return { ok: true, checked: lines.length, brokenAt: null };
  } catch (err) {
    return { ok: false, checked: 0, brokenAt: null, reason: err.message };
  }
}

function stripHash(rec) {
  const { hash, ...rest } = rec;
  return rest;
}

// ── Rate limiter (sliding per-minute window) ──────────────────────
class RateLimiter {
  constructor(rules = {}) {
    this.rules = rules;            // { tool: { perMinute }, "*": { perMinute } }
    this.hits = new Map();         // tool -> [timestamps]
  }

  /** Returns true when the call is allowed (under the limit). */
  allow(tool, now = Date.now()) {
    const limit = this.rules[tool]?.perMinute ?? this.rules['*']?.perMinute ?? 0;
    if (!limit) return true;
    const windowStart = now - 60_000;
    const hits = (this.hits.get(tool) || []).filter((t) => t > windowStart);
    if (hits.length >= limit) {
      this.hits.set(tool, hits);
      return false;
    }
    hits.push(now);
    this.hits.set(tool, hits);
    return true;
  }
}

// ── Policy presets ────────────────────────────────────────────────
export const PRESETS = {
  // Read-only: shell, network and browser disabled. Files confined to the
  // workspace. The agent can observe but not change anything.
  strict: {
    version: 1,
    audit: true,
    tools: {
      sysinfo: 'allow', files: 'allow', memory: 'allow', notify: 'allow',
      shell: 'deny', net: 'deny', web: 'deny', browser: 'deny', apps: 'deny',
    },
  },
  // Balanced: shell commands and browser require per-command approval;
  // everything else allowed. Rate limits on shell and net.
  standard: {
    version: 1,
    audit: true,
    tools: {
      sysinfo: 'allow', files: 'allow', memory: 'allow', notify: 'allow',
      shell: 'confirm', net: 'allow', web: 'allow', browser: 'confirm', apps: 'confirm',
    },
    rateLimits: {
      shell: { perMinute: 20 },
      net:   { perMinute: 60 },
      '*':   { perMinute: 300 },
    },
  },
  // Everything allowed (matches pre-policy behavior). Startup warning.
  permissive: {
    version: 1,
    audit: true,
    tools: {
      sysinfo: 'allow', shell: 'allow', files: 'allow', net: 'allow',
      web: 'allow', browser: 'allow', apps: 'allow', memory: 'allow', notify: 'allow',
    },
  },
};

export class Policy {
  constructor(raw = null) {
    const r = raw && typeof raw === 'object' ? raw : {};
    this.raw = r;
    this.toolRules = r.tools && typeof r.tools === 'object' ? r.tools : {};
    this.shellDeny = Array.isArray(r.shell?.deny) ? r.shell.deny : [];
    // New shape: shell.approval. Legacy shape: approval.patterns.
    this.approvalPatterns = Array.isArray(r.shell?.approval)
      ? r.shell.approval
      : Array.isArray(r.approval?.patterns) ? r.approval.patterns : [];
    this.shellUnsafe = r.shell?.unsafe === true;
    this.dailyTokens = Number(r.budget?.dailyTokens) || 0;
    this.dailyCostUsd = Number(r.budget?.dailyCostUsd) || 0;
    this.maxSteps = Math.min(16, Math.max(2, Number(r.maxSteps) || 8));
    this.auditEnabled = r.audit !== false;
    this.auditPath = typeof r.auditPath === 'string' ? r.auditPath : DEFAULT_AUDIT_PATH;
    this.rateLimiter = new RateLimiter(r.rateLimits && typeof r.rateLimits === 'object' ? r.rateLimits : {});

    // Deprecated env fallback: MONA_SHELL_UNSAFE=1 still works for one minor
    // version but is superseded by policy `shell.unsafe`. Prefer the policy file.
    if (!this.shellUnsafe && process.env.MONA_SHELL_UNSAFE === '1') {
      this.shellUnsafe = true;
      this._unsafeSource = 'env';
    } else {
      this._unsafeSource = this.shellUnsafe ? 'policy' : null;
    }
  }

  static load(path = DEFAULT_POLICY_PATH) {
    try {
      if (existsSync(path)) {
        return new Policy(JSON.parse(readFileSync(path, 'utf8')));
      }
    } catch {
      // unreadable/invalid policy → fall back to safe defaults
    }
    return new Policy(null);
  }

  /** Named presets: strict | standard | permissive */
  static preset(name) {
    if (!PRESETS[name]) {
      throw new Error(`Unknown preset "${name}" — use: ${Object.keys(PRESETS).join(', ')}`);
    }
    return new Policy(PRESETS[name]);
  }

  /** True when the env-var fallback is active (deprecated path). */
  get unsafeSource() { return this._unsafeSource; }

  /** Risk tier for a tool: allow | deny | confirm (default: allow for known tools). */
  toolTier(name) {
    const rule = this.toolRules[name];
    if (VALID_TIERS.has(rule)) return rule;
    return KNOWN_TOOLS.has(name) ? 'allow' : 'deny';
  }

  /** Check a tool call against the policy (policy + rate limits). */
  check(name, args = {}) {
    const tier = this.toolTier(name);
    let verdict;
    if (tier === 'deny') {
      verdict = { allowed: false, tier, reason: `Tool "${name}" is denied by policy` };
    } else if (tier === 'confirm') {
      verdict = { allowed: false, tier, reason: `Tool "${name}" requires approval` };
    } else if (!this.rateLimiter.allow(name)) {
      verdict = { allowed: false, tier: 'deny', reason: `Rate limit exceeded for "${name}"` };
    } else {
      verdict = { allowed: true, tier: 'allow', reason: '' };
    }
    if (this.auditEnabled) {
      auditWrite({
        kind: 'tool', tool: name,
        argsHash: sha256(JSON.stringify(args ?? {})).slice(0, 16),
        verdict: verdict.allowed ? 'allow' : verdict.tier,
        reason: verdict.reason,
      }, this.auditPath);
    }
    return verdict;
  }

  /** Check a shell command: base deny + policy deny + approval patterns. */
  shellCheck(cmd) {
    const c = String(cmd || '');
    for (const pat of BASE_DENY) {
      if (pat.test(c)) {
        return this.#audited('shell', 'deny', 'Blocked by base safety rules');
      }
    }
    for (const pat of this.shellDeny) {
      try {
        if (new RegExp(pat, 'i').test(c)) return this.#audited('shell', 'deny', 'Blocked by policy');
      } catch { /* invalid pattern ignored */ }
    }
    for (const pat of this.approvalPatterns) {
      try {
        if (new RegExp(pat, 'i').test(c)) return this.#audited('shell', 'confirm', 'Requires approval by policy');
      } catch { /* invalid pattern ignored */ }
    }
    if (!this.rateLimiter.allow('shell')) {
      return this.#audited('shell', 'deny', 'Rate limit exceeded for "shell"');
    }
    if (this.shellUnsafe) {
      return this.#audited('shell', 'unsafe', `Unrestricted shell (${this._unsafeSource}) — audited`);
    }
    return { allowed: true, tier: 'allow', reason: '' };
  }

  /** Explain why a call would be allowed/denied (for `mona-agent policy explain`). */
  explain(name, args = {}) {
    const tier = this.toolTier(name);
    let matched;
    if (this.toolRules[name]) matched = `tools.${name} = "${tier}"`;
    else if (KNOWN_TOOLS.has(name)) matched = 'default (known tool)';
    else matched = 'default (unknown tool)';
    const rateOk = this.rateLimiter.allow(name);
    const parts = [];
    if (tier === 'deny') parts.push(`denied by ${matched}`);
    else if (tier === 'confirm') parts.push(`requires approval by ${matched}`);
    else if (!rateOk) parts.push('rate limit exceeded');
    else parts.push('allowed');
    return {
      tool: name,
      decision: parts.join('; '),
      tier,
      rateLimited: !rateOk,
      matchedRule: matched,
      policyPath: DEFAULT_POLICY_PATH,
    };
  }

  #audited(kind, tier, reason) {
    if (this.auditEnabled) {
      auditWrite({ kind, tool: 'shell', verdict: tier, reason }, this.auditPath);
    }
    if (tier === 'confirm') return { allowed: false, tier, reason };
    return { allowed: false, tier, reason };
  }

  budget() {
    return { dailyTokens: this.dailyTokens, dailyCostUsd: this.dailyCostUsd };
  }
}
