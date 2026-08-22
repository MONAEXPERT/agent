// Coverage floor check — the security-critical modules only.
//
// The suites' guarantees are the product's pitch, so their line coverage
// must never silently regress. No global threshold (that produces
// test-writing theatre); a per-file floor just under what already exists,
// ratcheted up as coverage improves.
//
//   RA_COVERAGE=1 node scripts/run-tests.mjs     # writes coverage/coverage.lcov
//   node scripts/coverage-check.mjs              # fails below the floor
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// path-suffix → minimum line coverage %
// Floors sit ~1.5 points under measured coverage (measured 2026-08-22, the
// day coverage landed) so cross-version noise can't flake CI; ratchet up.
const FLOORS = {
  'apps/desktop/src/tools/shell.js': 94,
  'apps/desktop/src/tools/files.js': 87,
  'apps/desktop/src/tools/net.js': 86,
  'packages/engine/src/policy.js': 95,
  'packages/engine/src/capability-grant.js': 98,
  'packages/engine/src/audit-sign.js': 93,
  'packages/engine/src/run-state.js': 96,
};

const lcov = readFileSync(join(ROOT, 'coverage', 'coverage.lcov'), 'utf8');

const records = new Map(); // SF → { lf, lh }
let current = null;
for (const line of lcov.split(/\r?\n/)) {
  if (line.startsWith('SF:')) {
    current = line.slice(3).trim();
    records.set(current, { lf: 0, lh: 0 });
  } else if (line.startsWith('LF:')) {
    records.get(current).lf = Number(line.slice(3));
  } else if (line.startsWith('LH:')) {
    records.get(current).lh = Number(line.slice(3));
  }
}

let failed = false;
console.log('coverage floor check (security-critical modules):');
for (const [suffix, floor] of Object.entries(FLOORS)) {
  const entry = [...records.entries()].find(([sf]) => sf.endsWith(suffix));
  if (!entry) {
    console.log(`  MISSING  ${suffix} — file not in the coverage report`);
    failed = true;
    continue;
  }
  const { lf, lh } = entry[1];
  const pct = lf > 0 ? (lh / lf) * 100 : 0;
  const ok = pct >= floor;
  if (!ok) failed = true;
  console.log(`  ${ok ? 'ok ' : 'LOW '}  ${suffix.padEnd(44)} ${pct.toFixed(1).padStart(5)}%  (floor ${floor}%)`);
}
process.exit(failed ? 1 : 0);
