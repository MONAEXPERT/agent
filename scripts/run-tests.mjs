// Test runner — discovers every test file by walking the tree instead of a
// hand-maintained list. A new test file is picked up automatically; the
// floor guard fails the run if the discovered count ever drops below the
// recorded baseline (protection against accidental exclusion).
//
// Why not `node --test 'apps/**/test/*.test.mjs'`? Glob support in
// node --test arrived in Node 22, and CI still exercises Node 20. The
// walker here works on every supported Node (>= 20) with zero deps.
//
//   node scripts/run-tests.mjs            run everything, concurrency 1
//   node scripts/run-tests.mjs <regex>    only files matching the regex
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');

// Recorded baseline: files discovered when globs replaced the manual list.
// Raise it when you add a test file; it must never silently drop.
const MIN_TEST_FILES = 64;

const ROOTS = ['apps', 'packages'];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith('.test.mjs') && p.split(/[\\/]/).includes('test')) out.push(p);
  }
  return out;
}

const files = ROOTS.flatMap((r) => walk(join(ROOT, r)));
if (files.length < MIN_TEST_FILES) {
  console.error(`run-tests: discovered ${files.length} test files, expected at least ${MIN_TEST_FILES} — a test file was lost.`);
  process.exit(1);
}

const filter = process.argv[2];
let targets = filter ? files.filter((f) => f.includes(filter)) : files;

// The opt-in network integration file is excluded from default runs —
// the default suite must stay hermetic (air-gapped CI, proxies, customer
// pipelines). Run it explicitly: RA_NETWORK_TESTS=1 npm test -- network-integration
if (process.env.RA_NETWORK_TESTS !== '1') {
  targets = targets.filter((f) => !f.endsWith('network-integration.test.mjs'));
}

console.log(`run-tests: ${targets.length} test file(s) (of ${files.length} discovered, floor ${MIN_TEST_FILES})`);

// RA_COVERAGE=1: emit an LCOV report (Node's built-in coverage, no deps)
// for the coverage floor check in scripts/coverage-check.mjs.
const testArgs = ['--test', '--test-concurrency=1'];
if (process.env.RA_COVERAGE === '1') {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(ROOT, 'coverage'), { recursive: true });
  testArgs.push(
    '--experimental-test-coverage',
    '--test-reporter=lcov',
    `--test-reporter-destination=${join(ROOT, 'coverage', 'coverage.lcov')}`
  );
}

// Concurrency 1: several suites share fixture directories (audit-chain
// tests); serial execution keeps them deterministic.
const r = spawnSync(
  process.execPath,
  [...testArgs, ...targets],
  { stdio: 'inherit', cwd: ROOT }
);
if (r.error) {
  console.error(`run-tests: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
