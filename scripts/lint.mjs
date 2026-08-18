// Syntax lint — checks every source file parses (node --check), cross-platform.
// This is a lightweight guard, not a full linter; it catches the kind of
// breakage that would otherwise only surface when the file is imported.

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots = ['apps', 'packages'];
const files = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(entry)) files.push(p);
  }
}

for (const root of roots) walk(root);

let failed = 0;
for (const file of files) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    process.stderr.write((r.stderr || `${file}: syntax error`) + '\n');
  }
}

process.stdout.write(`lint: checked ${files.length} files, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
