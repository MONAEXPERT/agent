#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadCreds, saveCreds, requireKey, CRED_PATH } from '../src/config.js';
import { verifyKey } from '../src/cloud.js';
import { Agent } from '../src/agent.js';

const [cmd, ...rest] = process.argv.slice(2);

async function login() {
  const rl = createInterface({ input: stdin, output: stdout });
  const existing = loadCreds();
  if (existing?.apiKey) console.log('An API key is already saved. This will replace it.');
  const apiKey = (await rl.question('agent.mona.expert API key: ')).trim();
  rl.close();
  if (!apiKey) { console.error('No key entered.'); process.exit(1); }
  process.stdout.write('Verifying with cloud... ');
  try {
    const info = await verifyKey(apiKey);
    const path = saveCreds({ apiKey, agentId: info.agentId });
    console.log('OK');
    console.log(`Linked agent: ${info.agentId || '(pending)'}`);
    console.log(`Saved to ${path} (chmod 600, no LLM keys stored).`);
  } catch (e) {
    console.error('FAILED\n' + e.message);
    process.exit(1);
  }
}

async function run() {
  const creds = requireKey();
  const task = rest.join(' ');
  if (!task) { console.error('Usage: mona-agent run "<task>"'); process.exit(1); }
  const agent = new Agent(creds);
  process.stdout.write('\n');
  await agent.run(task, (t) => process.stdout.write(t));
  process.stdout.write('\n');
  agent.close();
}

function status() {
  const c = loadCreds();
  if (!c) { console.log('Not logged in. Run: mona-agent login'); return; }
  console.log(`Logged in. agentId=${c.agentId || '(pending)'} cred=${CRED_PATH}`);
}

function help() {
  console.log(`mona-agent — cloud-brained device agent

Usage:
  mona-agent login            Save your agent.mona.expert API key
  mona-agent status           Show login status
  mona-agent run "<task>"     Run a task (reasoning happens in the cloud)
  mona-agent gui              Start the local GUI (npm run gui)

No LLM provider keys are stored locally. All reasoning runs on agent.mona.expert.`);
}

switch (cmd) {
  case 'login': await login(); break;
  case 'status': status(); break;
  case 'run': await run(); break;
  case undefined:
  case 'help':
  case '-h':
  case '--help': help(); break;
  default: console.error(`Unknown command: ${cmd}`); help(); process.exit(1);
}
