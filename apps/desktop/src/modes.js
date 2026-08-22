// Modes — one-command configuration profiles for the agent.
//
// Think of it as a dial from "close to zero skills" to "full-blown
// OpenClaw-style daemon":
//
//   minimal   — read-only observer. No skills, no shell, no network
//               writes. The agent can look but barely touch.
//   standard  — balanced default. Core skills + safe tools; shell and
//               browser need per-command approval.
//   full      — everything on. All bundled skills, permissive policy,
//               daemon auto-start on login (launchd / systemd).
//
// `remoteagent mode set <name>` applies the whole profile:
//   - writes ~/.remoteagent/policy.json   (the device-side authority)
//   - enables / disables bundled skills
//   - optionally installs the auto-start daemon (full mode)
//
// The control plane can NEVER override a mode — policy is local-only.
// This file is the device-side authority, exactly like policy.json.

import { writeFileSync, existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, saveConfig } from './config.js';
import { SkillsManager, SKILLS_DIR } from './skills.js';
import { detect } from './sandbox.js';
import { env, PRESETS } from '@remoteagent/engine';

export const MODES = Object.freeze({
  minimal: {
    label: 'Minimal — close to zero skills',
    description: 'Read-only observer. No skills, no shell, no network writes. Best for untrusted environments.',
    policy: 'strict',
    skills: [],                       // nothing enabled
    daemon: false,                    // never auto-start
  },
  standard: {
    label: 'Standard — balanced',
    description: 'Core skills + safe tools. Shell and browser require per-command approval.',
    policy: 'standard',
    skills: ['briefing', 'disk-health'],  // safe, read-only skills
    daemon: false,                    // run manually: remoteagent start
  },
  full: {
    label: 'Full — OpenClaw-style daemon',
    description: 'Everything on: all bundled skills, permissive policy, auto-start daemon on login.',
    policy: 'permissive',
    skills: ['briefing', 'disk-health', 'web-research'],
    daemon: true,                     // install launchd/systemd auto-start
    requiresSandbox: true,            // OS containment (bwrap/sandbox-exec) is mandatory
  },
});

export const MODE_NAMES = Object.freeze(Object.keys(MODES));

export const POLICY_PATH = env('POLICY') || join(homedir(), '.remoteagent', 'policy.json');

/** Installed skill names (directories containing a SKILL.md). */
function installedSkillNames() {
  const names = [];
  try {
    if (existsSync(SKILLS_DIR)) {
      for (const e of readdirSync(SKILLS_DIR, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(SKILLS_DIR, e.name, 'SKILL.md'))) names.push(e.name);
      }
    }
  } catch { /* no skills dir yet */ }
  return names;
}

/** Current mode, read from config.json (default: standard). */
export function currentMode() {
  const cfg = loadConfig();
  return MODE_NAMES.includes(cfg.mode) ? cfg.mode : 'standard';
}

/** Apply a mode: write policy.json + skills + daemon flag. */
export function applyMode(name, { installDaemon = null, acceptNoSandbox = false, sandboxDetect = detect } = {}) {
  if (!MODES[name]) {
    throw new Error(`Unknown mode "${name}" — use: ${MODE_NAMES.join(', ')}`);
  }
  const mode = MODES[name];
  const sandbox = sandboxDetect();

  // Full mode is exactly the mode where containment must not be optional:
  // without an OS sandbox the only guard left is the path deny-list.
  if (mode.requiresSandbox && !acceptNoSandbox && !sandbox.available) {
    throw new Error(
      `Mode "full" requires an OS sandbox, but none is available (${sandbox.reason || 'no backend'}). ` +
      'Install bwrap (Linux) or ensure sandbox-exec exists (macOS), or pass --i-accept-no-sandbox ' +
      'to run full mode with the path deny-list only.'
    );
  }

  // 1) Policy file — the authority for tool tiers + budgets.
  const policy = PRESETS[mode.policy];
  if (!policy) throw new Error(`Unknown policy preset "${mode.policy}"`);
  mkdirSync(join(homedir(), '.remoteagent'), { recursive: true });
  writeFileSync(POLICY_PATH, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600 });

  // 2) Skills — enable exactly the mode's set (disable everything else).
  const manager = new SkillsManager();
  const have = installedSkillNames();
  const wanted = mode.skills.filter((s) => have.includes(s));
  manager.enabled = wanted;
  manager.saveRaw(wanted);

  // 3) Config — remember the mode; optionally force daemon install state.
  const cfg = loadConfig();
  cfg.mode = name;
  if (acceptNoSandbox) cfg.acceptNoSandbox = true;
  if (installDaemon === true || (installDaemon !== false && mode.daemon)) cfg.daemon = 'installed';
  saveConfig(cfg);

  return {
    mode: name,
    label: mode.label,
    policy: mode.policy,
    policyPath: POLICY_PATH,
    skills: wanted,
    daemon: cfg.daemon === 'installed',
    sandbox,
  };
}

/** Summary of the current mode (for `remoteagent mode show` / status). */
export function modeSummary() {
  const name = currentMode();
  const mode = MODES[name];
  const cfg = loadConfig();
  let policyTiers = null;
  try {
    if (existsSync(POLICY_PATH)) {
      const raw = JSON.parse(readFileSync(POLICY_PATH, 'utf8'));
      policyTiers = raw.tools || null;
    }
  } catch { /* unreadable policy */ }
  return {
    mode: name,
    label: mode.label,
    description: mode.description,
    policy: mode.policy,
    skills: mode.skills,
    daemon: cfg.daemon === 'installed',
    policyTiers,
    sandbox: detect(),
    acceptNoSandbox: Boolean(cfg.acceptNoSandbox),
  };
}
