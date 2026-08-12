#!/usr/bin/env node
// ── mona-agent CLI ────────────────────────────────────────────────
// Commands:
//   gui          Terminal dashboard (default when TTY)
//   start        Headless daemon
//   login        Save API key
//   connect      Test / force connection to control plane
//   chat <msg>   Send a message via API
//   exec <tool>  Execute a tool locally
//   debug        Debug mode — verbose logging
//   status       Show connection info
//   help         Show usage

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadCreds, saveCreds, requireCreds, CLOUD, DEFAULTS, PATHS } from '../src/config.js';
import { verifyKey } from '../src/cloud.js';
import { testConnection, sendChat } from '../src/api.js';
import { tools } from '../src/tools/index.js';
import { AgentDaemon } from '../src/agent.js';
import { Dashboard } from '../src/tui.js';
import { log } from '../src/log.js';

const [cmd, ...args] = process.argv.slice(2);

// ── ANSI constants ────────────────────────────────────────────────
const BOLD  = '\x1b[1m';
const DIM   = '\x1b[2m';
const RESET = '\x1b[0m';
const CYAN  = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED   = '\x1b[31m';
const MAGENTA = '\x1b[35m';

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
    console.log(`    ${CYAN}mona-agent gui${RESET}       ${DIM}# terminal dashboard${RESET}`);
    console.log(`    ${CYAN}mona-agent start${RESET}     ${DIM}# headless daemon${RESET}`);
    console.log(`    ${CYAN}mona-agent connect${RESET}   ${DIM}# test connection${RESET}`);
    console.log();
  } catch (e) {
    console.log(`${RED}FAILED${RESET}`);
    console.error(`\n  ${e.message}\n`);

    // Still allow saving if user wants to save anyway (e.g. offline setup)
    const saveAnyway = await rl.question('  Save anyway? (y/N): ');
    if (saveAnyway.toLowerCase() === 'y') {
      const path = saveCreds({ apiKey });
      console.log(`\n  ${YELLOW}Saved unverified key to ${path}${RESET}\n`);
    }
    process.exit(1);
  }
}

// ── connect (force connection test) ───────────────────────────────
async function connect() {
  const creds = requireCreds();

  const targetUrl = args[0] || CLOUD.base;
  const force = args.includes('--force') || args.includes('-f');

  console.log(`\n  ${BOLD}${CYAN}mona-agent connect${RESET}\n`);
  console.log(`  ${DIM}Target:${RESET}    ${targetUrl}`);
  console.log(`  ${DIM}API Key:${RESET}   ${creds.apiKey.slice(0, 8)}...`);
  console.log(`  ${DIM}Agent ID:${RESET}  ${creds.agentId || '(pending)'}`);
  console.log();

  if (force) {
    console.log(`  ${YELLOW}Force mode — bypassing cert checks${RESET}\n`);
  }

  const results = await testConnection(creds.apiKey, targetUrl);

  // Health
  if (results.health?.ok) {
    console.log(`  ${GREEN}●${RESET} Health    ${GREEN}OK${RESET}  (uptime ${results.health.uptime}s)`);
  } else {
    console.log(`  ${RED}●${RESET} Health    ${RED}FAILED${RESET}  ${results.health?.error || 'unreachable'}`);
  }

  // Auth
  if (results.auth && !results.auth.error) {
    console.log(`  ${GREEN}●${RESET} Auth      ${GREEN}OK${RESET}  (${results.auth.agentId || 'verified'})`);
  } else {
    console.log(`  ${RED}●${RESET} Auth      ${RED}FAILED${RESET}  ${results.auth?.error || ''}`);
  }

  // Agents
  if (results.agents && !results.agents.error) {
    const count = Array.isArray(results.agents) ? results.agents.length : results.agents.agents?.length || 0;
    console.log(`  ${GREEN}●${RESET} Agents    ${GREEN}${count} connected${RESET}`);
  } else if (results.agents?.error) {
    console.log(`  ${YELLOW}●${RESET} Agents    ${YELLOW}unavailable${RESET}  ${results.agents.error}`);
  }

  // Summary
  const allOk = results.health?.ok && results.auth && !results.auth.error;
  console.log();
  console.log(`  ${allOk ? GREEN + 'Connection successful!' : RED + 'Connection issues detected'}${RESET}`);
  console.log(`  ${DIM}Run ${CYAN}mona-agent debug${RESET}${DIM} for verbose output${RESET}`);
  console.log();
}

// ── chat (send a message via API) ─────────────────────────────────
async function chat() {
  const creds = requireCreds();
  const message = args.join(' ');

  if (!message) {
    console.log(`\n  ${BOLD}mona-agent chat${RESET}\n`);
    console.log(`  ${DIM}Usage:${RESET} mona-agent chat ${CYAN}<message>${RESET}`);
    console.log(`  ${DIM}Send a chat message to the connected agent.${RESET}\n`);
    process.exit(1);
  }

  const agentId = creds.agentId || 'default';

  console.log(`\n  ${BOLD}mona-agent chat${RESET}\n`);
  console.log(`  ${DIM}Agent:${RESET}  ${agentId}`);
  console.log(`  ${DIM}Cloud:${RESET}  ${CLOUD.base}`);
  console.log(`\n  ${CYAN}▸${RESET} ${message}\n`);

  try {
    process.stdout.write(`  ${MAGENTA}Thinking...${RESET}`);
    const reply = await sendChat(creds.apiKey, agentId, message);
    process.stdout.write(`\r  ${GREEN}Response:${RESET}\n\n`);
    console.log(`  ${reply.reply || reply.text || JSON.stringify(reply, null, 2)}`);
    console.log();
  } catch (err) {
    console.log(`\r  ${RED}Failed:${RESET} ${err.message}\n`);
    process.exit(1);
  }
}

// ── exec (run a tool directly) ────────────────────────────────────
async function execTool() {
  const toolName = args[0];
  const toolArgs = {};

  // Parse key=value args
  for (let i = 1; i < args.length; i++) {
    const eq = args[i].indexOf('=');
    if (eq > 0) {
      toolArgs[args[i].slice(0, eq)] = args[i].slice(eq + 1);
    }
  }

  if (!toolName) {
    console.log(`\n  ${BOLD}mona-agent exec${RESET}\n`);
    console.log(`  ${DIM}Usage:${RESET} mona-agent exec ${CYAN}<tool> [key=value...]${RESET}\n`);
    console.log(`  ${DIM}Available tools:${RESET}`);
    for (const t of tools.list()) {
      console.log(`    ${CYAN}${t.name.padEnd(14)}${RESET} ${DIM}${t.description}${RESET}`);
    }
    console.log();
    return;
  }

  console.log(`\n  ${BOLD}mona-agent exec${RESET}\n`);
  console.log(`  ${DIM}Tool:${RESET}  ${toolName}`);
  if (Object.keys(toolArgs).length > 0) {
    console.log(`  ${DIM}Args:${RESET}  ${JSON.stringify(toolArgs)}`);
  }
  console.log();

  const t0 = Date.now();
  const result = await tools.run(toolName, toolArgs);
  const elapsed = Date.now() - t0;

  if (result.error) {
    console.log(`  ${RED}Error (${elapsed}ms):${RESET}`);
    console.log(`  ${result.error}`);
    if (result.available) {
      console.log(`  ${DIM}Available: ${result.available.join(', ')}${RESET}`);
    }
    if (result.allowed) {
      console.log(`  ${DIM}Allowlist: ${result.allowed.join(', ')}${RESET}`);
    }
  } else {
    console.log(`  ${GREEN}OK${RESET} ${DIM}(${elapsed}ms)${RESET}\n`);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.log(`${YELLOW}${result.stderr}${RESET}`);
    console.log(JSON.stringify(result, null, 2).length > 200
      ? JSON.stringify({ ...result, stdout: result.stdout?.slice(0, 200) + '...' }, null, 2)
      : JSON.stringify(result, null, 2));
  }
  console.log();
}

// ── debug (verbose logging mode) ──────────────────────────────────
async function debug() {
  const creds = loadCreds();

  console.log(`\n  ${BOLD}${MAGENTA}mona-agent debug${RESET}\n`);

  // Environment
  console.log(`  ${BOLD}Environment${RESET}`);
  console.log(`  ${DIM}Cloud:${RESET}     ${CLOUD.base}`);
  console.log(`  ${DIM}WS URL:${RESET}    ${CLOUD.wsUrl}`);
  console.log(`  ${DIM}Version:${RESET}   ${DEFAULTS.version}`);
  console.log(`  ${DIM}Node:${RESET}      ${process.version}`);
  console.log(`  ${DIM}Platform:${RESET}  ${process.platform} ${process.arch}`);
  console.log(`  ${DIM}PID:${RESET}       ${process.pid}`);

  // Creds
  console.log(`\n  ${BOLD}Credentials${RESET}`);
  if (creds?.apiKey) {
    console.log(`  ${DIM}API Key:${RESET}   ${GREEN}present${RESET} (${creds.apiKey.slice(0, 8)}...)`);
    console.log(`  ${DIM}Agent ID:${RESET}  ${creds.agentId || '(pending)'}`);
    console.log(`  ${DIM}File:${RESET}      ${PATHS.creds}`);
  } else {
    console.log(`  ${DIM}API Key:${RESET}   ${RED}not set${RESET}`);
    console.log(`  ${DIM}Run:${RESET}       ${CYAN}mona-agent login${RESET}`);
  }

  // Tools
  console.log(`\n  ${BOLD}Registered Tools${RESET}`);
  for (const t of tools.list()) {
    console.log(`  ${CYAN}${t.name.padEnd(14)}${RESET} ${DIM}${t.description}${RESET}`);
  }

  // Config
  console.log(`\n  ${BOLD}Config${RESET}`);
  console.log(`  ${DIM}MONA_CLOUD:${RESET}       ${process.env.MONA_CLOUD || '(default)'}`);
  console.log(`  ${DIM}MONA_CLOUD_WS:${RESET}    ${process.env.MONA_CLOUD_WS || '(auto)'}`);
  console.log(`  ${DIM}MONA_ALLOW_CMDS:${RESET}  ${process.env.MONA_ALLOW_CMDS || '(default)'}`);
  console.log(`  ${DIM}MONA_SHELL_UNSAFE:${RESET} ${process.env.MONA_SHELL_UNSAFE || '0'}`);
  console.log(`  ${DIM}MONA_WORKSPACE:${RESET}   ${process.env.MONA_WORKSPACE || '(default)'}`);

  // Connection test
  if (creds?.apiKey) {
    console.log(`\n  ${BOLD}Connection Test${RESET}`);
    console.log(`  ${DIM}Testing ${CLOUD.base}...${RESET}\n`);

    try {
      const results = await testConnection(creds.apiKey);
      for (const [name, result] of Object.entries(results)) {
        const ok = result?.ok || (!result?.error && result !== undefined);
        const icon = ok ? GREEN + '●' : RED + '●';
        const detail = result?.error
          ? `${RED}${result.error}${RESET}`
          : result?.uptime
            ? `${GREEN}uptime ${result.uptime}s${RESET}`
            : result?.agentId
              ? `${GREEN}${result.agentId}${RESET}`
              : '';
        console.log(`  ${icon} ${name.padEnd(12)} ${detail}${RESET}`);
      }
    } catch (err) {
      console.log(`  ${RED}Connection test failed: ${err.message}${RESET}`);
    }
  }

  console.log();
}

// ── gui (terminal dashboard) ──────────────────────────────────────
async function gui() {
  const creds = loadCreds();
  log.quiet(true); // Suppress console output; TUI handles display

  // No API key yet? Start the dashboard in setup mode — it shows the
  // connect guide and supports inline login (press l).
  const daemon = creds ? new AgentDaemon(creds) : null;
  const dashboard = new Dashboard(daemon, { setup: !creds });

  const stop = () => {
    dashboard.stop();
    daemon?.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  daemon?.start();
  dashboard.start();
}

// ── start (headless) ──────────────────────────────────────────────
async function start() {
  const creds = requireCreds();

  console.log(`\n  ${BOLD}${CYAN}mona-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}`);
  console.log(`  ${DIM}Headless daemon — controlled from ${CLOUD.base}${RESET}`);
  console.log(`  ${DIM}Log level: ${log.level || 'info'}${RESET}`);
  console.log();

  const daemon = new AgentDaemon(creds);

  daemon.on('connected', () => {
    process.stderr.write(`  ${GREEN}● Connected to ${CLOUD.base}${RESET}\n`);
  });

  daemon.on('disconnected', (code) => {
    process.stderr.write(`  ${YELLOW}○ Disconnected (code ${code}), reconnecting...${RESET}\n`);
  });

  daemon.on('task:done', (result) => {
    process.stderr.write(`  ${GREEN}✓ Done (${result.tokens} tokens)${RESET}\n`);
  });

  daemon.on('error', (err) => {
    process.stderr.write(`  ${RED}✗ ${err.message}${RESET}\n`);
  });

  const stop = () => {
    process.stderr.write(`\n  ${DIM}Shutting down...${RESET}\n`);
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
  console.log(`  ${DIM}WS URL:${RESET}  ${CLOUD.wsUrl}`);
  console.log(`  ${DIM}Creds:${RESET}   ${PATHS.creds}`);
  console.log(`  ${DIM}Config:${RESET}  ${PATHS.dir}`);
  console.log(`  ${DIM}Tools:${RESET}   ${tools.names().join(', ')}`);
  console.log();
}

// ── help ──────────────────────────────────────────────────────────
function help() {
  console.log(`
  ${BOLD}mona-agent${RESET} ${DIM}v${DEFAULTS.version}${RESET}
  Cloud-brained device agent. No local LLM keys.

  ${BOLD}USAGE${RESET}

    mona-agent ${CYAN}<command>${RESET} ${DIM}[options]${RESET}

  ${BOLD}COMMANDS${RESET}

    ${CYAN}gui${RESET}               Terminal dashboard with live metrics   ${DIM}(default)${RESET}
                             (no key saved? press ${CYAN}l${RESET} inside to log in)
    ${CYAN}start${RESET}             Headless daemon (no UI)
    ${CYAN}login${RESET}             Save your agent.mona.expert API key
    ${CYAN}connect${RESET} ${DIM}[url]${RESET}   Test / force connection to control plane
    ${CYAN}chat${RESET} ${DIM}<msg>${RESET}      Send a chat message via API
    ${CYAN}exec${RESET} ${DIM}<tool>${RESET}     Execute a tool directly (sysinfo, shell, files, net)
    ${CYAN}debug${RESET}             Debug mode — verbose system + connection info
    ${CYAN}status${RESET}            Show login and connection info
    ${CYAN}help${RESET}              Show this help

  ${BOLD}EXAMPLES${RESET}

    ${DIM}# Login to your control plane${RESET}
    mona-agent login

    ${DIM}# Start the terminal dashboard${RESET}
    mona-agent gui

    ${DIM}# Test connection to custom endpoint${RESET}
    mona-agent connect http://localhost:4300

    ${DIM}# Send a chat message${RESET}
    mona-agent chat "What is the system status?"

    ${DIM}# Execute a local tool${RESET}
    mona-agent exec sysinfo
    mona-agent exec shell cmd=uptime
    mona-agent exec files action=list path=/tmp

    ${DIM}# Debug mode${RESET}
    mona-agent debug

  ${BOLD}ENVIRONMENT${RESET}

    MONA_CLOUD        Cloud base URL     ${DIM}(default: ${CLOUD.base})${RESET}
    MONA_CLOUD_WS     WebSocket URL      ${DIM}(auto-derived from MONA_CLOUD)${RESET}
    MONA_ALLOW_CMDS   Shell allowlist    ${DIM}(comma-separated command names)${RESET}
    MONA_SHELL_UNSAFE Allow all shell    ${DIM}(set to 1 — NOT recommended)${RESET}
    MONA_WORKSPACE    File tool sandbox  ${DIM}(default: ~/.mona-agent/workspace)${RESET}

  ${BOLD}QUICK START${RESET}

    ${DIM}# 1. Login${RESET}
    mona-agent login

    ${DIM}# 2. Verify connection${RESET}
    mona-agent connect

    ${DIM}# 3. Start the dashboard${RESET}
    mona-agent gui

  ${DIM}All reasoning runs on ${BOLD}${CLOUD.base}${RESET}${DIM}. No LLM keys stored locally.${RESET}
`);
}

// ── Dispatch ──────────────────────────────────────────────────────
switch (cmd) {
  case 'login':               await login(); break;
  case 'gui':                 await gui(); break;
  case 'start':               await start(); break;
  case 'connect':             await connect(); break;
  case 'chat':                await chat(); break;
  case 'exec':                await execTool(); break;
  case 'debug':               await debug(); break;
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
