#!/usr/bin/env node
// ── mona-agent CLI ────────────────────────────────────────────────
// Commands:
//   gui     Terminal dashboard (default when TTY)
//   start   Headless daemon
//   login   Save API key
//   status  Show connection info
//   help    Show usage

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadCreds, saveCreds, requireCreds, CLOUD, DEFAULTS, PATHS } from '../src/config.js';
import { verifyKey } from '../src/cloud.js';
import { AgentDaemon } from '../src/agent.js';
import { Dashboard } from '../src/tui.js';
import { log } from '../src/log.js';

const [cmd] = process.argv.slice(2);

// ── login ─────────────────────────────────────────────────────────
async function login() {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = loadCreds();

  console.log(`\n  ${BOLD}mona-agent login${RESET}\n`);

  if (existing?.apiKey) {
    console.log(`  ${DIM}An API key is already saved. This will replace it.${RESET}\n`);
  }

  const apiKey = (await rl.question('  agent.mona.expert API key: ')).trim();
  rl.close();

  if (!apiKey) {
    console.error('\n  No key entered.\n');
    process.exit(1);
  }

  process.stdout.write(`\n  Verifying with ${CLOUD.base}... `);

  try {
    const info = await verifyKey(apiKey);
    const path = saveCreds({ apiKey, agentId: info.agentId });

    console.log(`${GREEN}OK${RESET}`);
    console.log(`\n  ${DIM}Agent:${RESET}  ${info.agentId || '(pending)'}`);
    console.log(`  ${DIM}Saved:${RESET}  ${path}`);
    console.log(`  ${DIM}Cloud:${RESET}  ${CLOUD.base}`);
    console.log(`\n  Start the daemon:\n`);
    console.log(`    ${CYAN}mona-agent gui${RESET}     ${DIM}# terminal dashboard${RESET}`);
    console.log(`    ${CYAN}mona-agent start${RESET}   ${DIM}# headless daemon${RESET}`);
    console.log();
  } catch (e) {
    console.log(`${RED}FAILED${RESET}`);
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
}

// ── gui (terminal dashboard) ──────────────────────────────────────
async function gui() {
  const creds = requireCreds();
  log.quiet(true); // Suppress console output; TUI handles display

  const daemon = new AgentDaemon(creds);
  const dashboard = new Dashboard(daemon);

  const stop = () => {
    dashboard.stop();
    daemon.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  daemon.start();
  dashboard.start();
}

// ── start (headless) ──────────────────────────────────────────────
async function start() {
  const creds = requireCreds();

  console.log(`\n  ${BOLD}${CYAN}mona-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}`);
  console.log(`  ${DIM}Headless daemon — controlled from ${CLOUD.base}${RESET}\n`);

  const daemon = new AgentDaemon(creds);

  const stop = () => {
    console.log(`\n  ${DIM}Shutting down...${RESET}\n`);
    daemon.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  daemon.start();

  // Keep process alive; all work is driven by inbound commands.
  setInterval(() => {}, 1 << 30);
}

// ── status ────────────────────────────────────────────────────────
function status() {
  const c = loadCreds();
  console.log(`\n  ${BOLD}mona-agent status${RESET}\n`);

  if (!c?.apiKey) {
    console.log(`  ${RED}Not logged in.${RESET} Run: ${CYAN}mona-agent login${RESET}\n`);
    return;
  }

  console.log(`  ${DIM}Agent:${RESET}   ${c.agentId || '(pending)'}`);
  console.log(`  ${DIM}Cloud:${RESET}   ${CLOUD.base}`);
  console.log(`  ${DIM}Creds:${RESET}   ${PATHS.creds}`);
  console.log(`  ${DIM}Config:${RESET}  ${PATHS.dir}`);
  console.log();
}

// ── help ──────────────────────────────────────────────────────────
function help() {
  console.log(`
  ${BOLD}mona-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}
  Cloud-brained device agent. No local LLM keys.

  ${BOLD}USAGE${RESET}

    mona-agent ${CYAN}<command>${RESET}

  ${BOLD}COMMANDS${RESET}

    ${CYAN}gui${RESET}       Terminal dashboard with live metrics   ${DIM}(default)${RESET}
    ${CYAN}start${RESET}     Headless daemon (no UI)
    ${CYAN}login${RESET}     Save your agent.mona.expert API key
    ${CYAN}status${RESET}    Show login and connection info
    ${CYAN}help${RESET}      Show this help

  ${BOLD}ENVIRONMENT${RESET}

    MONA_CLOUD        Cloud base URL     ${DIM}(default: ${CLOUD.base})${RESET}
    MONA_CLOUD_WS     WebSocket URL      ${DIM}(auto-derived from MONA_CLOUD)${RESET}
    MONA_ALLOW_CMDS   Shell allowlist    ${DIM}(comma-separated command names)${RESET}
    MONA_SHELL_UNSAFE Allow all shell    ${DIM}(set to 1 — NOT recommended)${RESET}
    MONA_WORKSPACE    File tool sandbox  ${DIM}(default: ~/.mona-agent/workspace)${RESET}

  ${BOLD}QUICK START${RESET}

    ${DIM}$${RESET} mona-agent login       ${DIM}# paste your API key${RESET}
    ${DIM}$${RESET} mona-agent gui         ${DIM}# terminal dashboard${RESET}

  All reasoning runs on ${BOLD}${CLOUD.base}${RESET}. No LLM keys stored locally.
`);
}

// ── ANSI constants ────────────────────────────────────────────────
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const RED   = '\x1b[31m';

// ── Dispatch ──────────────────────────────────────────────────────
switch (cmd) {
  case 'login':               await login(); break;
  case 'gui':                 await gui(); break;
  case 'start':               await start(); break;
  case 'status':              status(); break;
  case undefined:
    // Default: GUI if TTY, headless otherwise
    if (process.stdout.isTTY) await gui();
    else                      await start();
    break;
  case 'help': case '-h': case '--help':
    help();
    break;
  default:
    console.error(`\n  Unknown command: ${cmd}\n  Run ${CYAN}mona-agent help${RESET} for usage.\n`);
    process.exit(1);
}
