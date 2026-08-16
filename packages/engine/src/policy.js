// Policy-as-code: user-editable rules that govern what the agent may do.
//
// Loaded from MONA_POLICY (path to a JSON file) or ~/.mona-agent/policy.json.
// If neither exists, a safe default policy applies (allow known tools,
// block destructive shell patterns, require confirmation on dangerous ones).
//
// Policy shape (all fields optional):
// {
//   "tools":   { "shell": "confirm", "web": "deny", ... },   // allow | deny | confirm
//   "shell":   { "deny": ["pattern", ...] },                 // extra blocked patterns
//   "approval":{"patterns": ["sudo", ...] },                 // patterns that need confirmation
//   "budget":  { "dailyTokens": 500000, "dailyCostUsd": 2 }, // 0 = unlimited
//   "maxSteps": 12
// }

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_POLICY_PATH = process.env.MONA_POLICY || join(homedir(), '.mona-agent', 'policy.json');

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

export class Policy {
  constructor(raw = null) {
    const r = raw && typeof raw === 'object' ? raw : {};
    this.raw = r;
    this.toolRules = r.tools && typeof r.tools === 'object' ? r.tools : {};
    this.shellDeny = Array.isArray(r.shell?.deny) ? r.shell.deny : [];
    this.approvalPatterns = Array.isArray(r.approval?.patterns) ? r.approval.patterns : [];
    this.dailyTokens = Number(r.budget?.dailyTokens) || 0;
    this.dailyCostUsd = Number(r.budget?.dailyCostUsd) || 0;
    this.maxSteps = Math.min(16, Math.max(2, Number(r.maxSteps) || 8));
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

  /** Risk tier for a tool: allow | deny | confirm (default: allow for known tools). */
  toolTier(name) {
    const rule = this.toolRules[name];
    if (rule === 'deny' || rule === 'confirm' || rule === 'allow') return rule;
    return KNOWN_TOOLS.has(name) ? 'allow' : 'deny';
  }

  /** Check a tool call against the policy. */
  check(name, args = {}) {
    const tier = this.toolTier(name);
    if (tier === 'deny') return { allowed: false, tier, reason: `Tool "${name}" is denied by policy` };
    if (tier === 'confirm') return { allowed: false, tier, reason: `Tool "${name}" requires approval` };
    return { allowed: true, tier, reason: '' };
  }

  /** Check a shell command: base deny + policy deny + approval patterns. */
  shellCheck(cmd) {
    const c = String(cmd || '');
    for (const pat of BASE_DENY) {
      if (pat.test(c)) return { allowed: false, tier: 'deny', reason: 'Blocked by base safety rules' };
    }
    for (const pat of this.shellDeny) {
      try {
        if (new RegExp(pat, 'i').test(c)) return { allowed: false, tier: 'deny', reason: 'Blocked by policy' };
      } catch { /* invalid pattern ignored */ }
    }
    for (const pat of this.approvalPatterns) {
      try {
        if (new RegExp(pat, 'i').test(c)) return { allowed: false, tier: 'confirm', reason: 'Requires approval by policy' };
      } catch { /* invalid pattern ignored */ }
    }
    return { allowed: true, tier: 'allow', reason: '' };
  }

  budget() {
    return { dailyTokens: this.dailyTokens, dailyCostUsd: this.dailyCostUsd };
  }
}
