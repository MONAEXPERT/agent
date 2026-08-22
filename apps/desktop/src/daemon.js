// Daemon — run the agent as a background service, OpenClaw-style.
//
//   macOS:  LaunchAgent  ~/Library/LaunchAgents/online.remoteagent.agent.plist
//   Linux:  systemd user unit  ~/.config/systemd/user/remoteagent.service
//
// `remoteagent daemon install` writes the unit, (re)loads it, and starts it.
// `remoteagent daemon uninstall` stops + removes it.
// `remoteagent daemon status` reports service + single-instance state.
//
// Rebrand migration: the pre-rebrand labels (`com.monaexpert.agent`,
// `mona-agent.service`) are booted out / disabled on install so the old
// agent never keeps running under the old name.
//
// Single-instance guard: a PID file (~/.remoteagent/daemon.pid) prevents two
// daemons racing for the same control-plane connection. `start` refuses to
// run twice (unless --force is given, e.g. after a crash with a stale PID).

import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { PATHS } from './config.js';
import { runtimeSupport } from './platform.js';
import { windowsServiceInstall, windowsServiceUninstall, windowsServiceStatus, windowsServiceStop } from './windows-service.js';
import { env } from '@remoteagent/engine';

export const PID_FILE = join(PATHS.dir, 'daemon.pid');

const LAUNCHD_LABEL = 'online.remoteagent.agent';
const LEGACY_LAUNCHD_LABEL = 'com.monaexpert.agent';
const LAUNCHD_PATH  = join(homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
const LEGACY_LAUNCHD_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LEGACY_LAUNCHD_LABEL}.plist`);
const SYSTEMD_PATH  = join(homedir(), '.config', 'systemd', 'user', 'remoteagent.service');
const LEGACY_SYSTEMD_PATH = join(homedir(), '.config', 'systemd', 'user', 'mona-agent.service');
const SYSTEMD_UNIT  = 'remoteagent.service';
const LEGACY_SYSTEMD_UNIT = 'mona-agent.service';

function agentBin() {
  // The `remoteagent` command on PATH; fall back to the repo bin.
  return env('AGENT_BIN') || 'remoteagent';
}

// ── launchd (macOS) ──────────────────────────────────────────────
function launchdPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/zsh</string>
        <string>-lc</string>
        <string>exec ${agentBin()} start --force</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${PATHS.dir}/daemon.log</string>
    <key>StandardErrorPath</key>
    <string>${PATHS.dir}/daemon.log</string>
</dict>
</plist>
`;
}

function launchdInstalled() {
  return existsSync(LAUNCHD_PATH);
}

function launchdInstall() {
  // Rebrand migration: boot out + remove the pre-rebrand agent first.
  const uid = process.getuid?.() ?? 0;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LEGACY_LAUNCHD_LABEL}`], { stdio: 'ignore' });
  try { if (existsSync(LEGACY_LAUNCHD_PATH)) unlinkSync(LEGACY_LAUNCHD_PATH); } catch { /* best effort */ }
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  writeFileSync(LAUNCHD_PATH, launchdPlist(), { mode: 0o644 });
  spawnSync('launchctl', ['unload', LAUNCHD_PATH], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['load', LAUNCHD_PATH], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function launchdUninstall() {
  spawnSync('launchctl', ['unload', LAUNCHD_PATH], { stdio: 'ignore' });
  try { if (existsSync(LAUNCHD_PATH)) unlinkSync(LAUNCHD_PATH); } catch { /* best effort */ }
  // Also clean up the pre-rebrand label if it is still around.
  const uid = process.getuid?.() ?? 0;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LEGACY_LAUNCHD_LABEL}`], { stdio: 'ignore' });
  try { if (existsSync(LEGACY_LAUNCHD_PATH)) unlinkSync(LEGACY_LAUNCHD_PATH); } catch { /* best effort */ }
}

function launchdStatus() {
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid?.() ?? process.env.UID ?? '501'}/${LAUNCHD_LABEL}`], { encoding: 'utf8' });
  const loaded = r.status === 0;
  let running = false;
  if (loaded) {
    running = /state = running/.test(r.stdout || '') || /pid = \d+/.test(r.stdout || '');
  }
  return { installed: launchdInstalled(), loaded, running };
}

// ── systemd (Linux) ──────────────────────────────────────────────
function systemdUnit() {
  return `[Unit]
Description=RemoteAgent — AI agent runtime for this device (local policy enforcement)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${agentBin()} start --force
Restart=on-failure
RestartSec=10
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=%h/.remoteagent
MemoryMax=1G

[Install]
WantedBy=default.target
`;
}

function systemdInstalled() {
  return existsSync(SYSTEMD_PATH);
}

function systemdInstall() {
  // Rebrand migration: disable + remove the pre-rebrand unit first.
  spawnSync('systemctl', ['--user', 'disable', '--now', LEGACY_SYSTEMD_UNIT], { stdio: 'ignore' });
  try { if (existsSync(LEGACY_SYSTEMD_PATH)) unlinkSync(LEGACY_SYSTEMD_PATH); } catch { /* best effort */ }
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(SYSTEMD_PATH, systemdUnit(), { mode: 0o644 });
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  const r = spawnSync('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT], { encoding: 'utf8' });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function systemdUninstall() {
  spawnSync('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT], { stdio: 'ignore' });
  spawnSync('systemctl', ['--user', 'disable', '--now', LEGACY_SYSTEMD_UNIT], { stdio: 'ignore' });
  try { if (existsSync(SYSTEMD_PATH)) unlinkSync(SYSTEMD_PATH); } catch { /* best effort */ }
  try { if (existsSync(LEGACY_SYSTEMD_PATH)) unlinkSync(LEGACY_SYSTEMD_PATH); } catch { /* best effort */ }
  spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

function systemdStatus() {
  const r = spawnSync('systemctl', ['--user', 'is-active', SYSTEMD_UNIT], { encoding: 'utf8' });
  return {
    installed: systemdInstalled(),
    loaded: r.status === 0 || (r.stdout || '').trim() !== 'inactive',
    running: (r.stdout || '').trim() === 'active',
  };
}

// ── Public API ───────────────────────────────────────────────────
export function isMac() { return platform() === 'darwin'; }
export function isWindows() { return platform() === 'win32'; }

function windowsStatus() {
  return windowsServiceStatus();
}

export function daemonStatus() {
  const st = isWindows() ? windowsStatus() : (isMac() ? launchdStatus() : systemdStatus());
  const pid = readPid();
  return {
    platform: platform(),
    serviceInstalled: st.installed,
    serviceLoaded: st.loaded,
    serviceRunning: st.running,
    serviceSupported: st.supported !== false,
    serviceReason: st.reason || null,
    runtimeSupport: runtimeSupport(),
    pid: pid?.pid ?? null,
    pidAlive: pid ? pidAlive(pid.pid) : false,
  };
}

export function daemonInstall() {
  if (isWindows()) return windowsServiceInstall();
  return isMac() ? launchdInstall() : systemdInstall();
}

export function daemonUninstall() {
  if (isWindows()) { const result = windowsServiceUninstall(); clearPid(); return result; }
  if (isMac()) launchdUninstall(); else systemdUninstall();
  clearPid();
}

// ── Single-instance guard (PID file) ─────────────────────────────
export function writePid() {
  mkdirSync(PATHS.dir, { recursive: true });
  writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, ts: Date.now() }), { mode: 0o600 });
}

export function clearPid() {
  try { if (existsSync(PID_FILE)) unlinkSync(PID_FILE); } catch { /* best effort */ }
}

export function readPid() {
  try {
    if (!existsSync(PID_FILE)) return null;
    return JSON.parse(readFileSync(PID_FILE, 'utf8'));
  } catch { return null; }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

/**
 * Guard: return true when another daemon instance is already running.
 * A stale PID file (process no longer alive) is cleaned up automatically.
 */
export function alreadyRunning() {
  const pid = readPid();
  if (!pid) return false;
  if (pidAlive(pid.pid)) return true;
  clearPid();
  return false;
}

/** Kill the running daemon (used by `daemon uninstall` + `stop`). */
export function stopRunningDaemon() {
  if (isWindows()) return windowsServiceStop();
  const pid = readPid();
  if (!pid) return false;
  try {
    process.kill(pid.pid, 'SIGTERM');
    return true;
  } catch { return false; }
}

// Re-export paths so the CLI can print them.
export const DAEMON_PATHS = Object.freeze({
  launchd: LAUNCHD_PATH,
  systemd: SYSTEMD_PATH,
  pid: PID_FILE,
  log: join(PATHS.dir, 'daemon.log'),
});
