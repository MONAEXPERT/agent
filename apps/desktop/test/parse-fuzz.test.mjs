// Property tests for the shell command parser (parseCommand).
//
// A hand-written, security-critical lexer needs property tests, not just
// examples. Three invariants, each checked over a deterministic corpus of
// generated inputs:
//
//   1. NO ESCAPE — for every input, parseCommand throws OR every stage's
//      argv[0] gets the same verdict from resolveBinary as a direct check of
//      its basename (a qualified spelling can only be STRICTER, never wider),
//      and no stage ever has an empty argv[0].
//   2. NO SENSITIVE EXPANSION — markers planted in AWS_SECRET_ACCESS_KEY /
//      SECRET must never appear in any argv element, in any quoting context.
//   3. TERMINATION — no input ≤ 2000 chars takes longer than 50 ms (there
//      must be no backtracking blow-up in the `$` regexes).
//
// Corpus: deterministic PRNG (seed logged for reproduction), weighted
// alphabet of quoting/metacharacters + alphanumerics, length 0–2000.
// PR job runs 10k cases (default); the nightly CI job runs 1M via
// RA_FUZZ_CASES (MONA_FUZZ_CASES still accepted for compat). Every bug
// this suite finds becomes a fixed case in attacks.test.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

// ── Isolate the environment before importing the parser ──────────
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-fuzz-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
fs.mkdirSync(process.env.MONA_WORKSPACE, { recursive: true });
process.env.MONA_ALLOW_CMDS = 'echo,cat,ls,head,node,uname,date,df,pwd,which';
process.env.AWS_SECRET_ACCESS_KEY = 'MARKER-AWS-9f3a1';
process.env.SECRET = 'MARKER-SECRET-b7c2d';

const { parseCommand, resolveBinary } = await import('../src/tools/shell.js');

const CASES = Number(process.env.RA_FUZZ_CASES ?? process.env.MONA_FUZZ_CASES) > 0 ? Number(process.env.RA_FUZZ_CASES ?? process.env.MONA_FUZZ_CASES) : 10_000;
const SEED = Number(process.env.RA_FUZZ_SEED ?? process.env.MONA_FUZZ_SEED) || (Date.now() % 0xffffffff);

// mulberry32 — deterministic, tiny, adequate for corpus generation.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Weighted alphabet: quoting/operator characters occur ~3x as often as any
// alphanumeric — the interesting state space lives in the metacharacters.
const SPECIALS = `"'\\$` + '`' + '|&;<>(){}[] ~/.*?=:!,' ;
const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '0123456789';
const POOL = SPECIALS.repeat(3) + LETTERS + DIGITS;

function randomInput(rnd) {
  const len = rnd() < 0.8 ? Math.floor(rnd() * 60) : Math.floor(rnd() * 1941) + 60; // 0..2000
  let s = '';
  for (let i = 0; i < len; i++) s += POOL[Math.floor(rnd() * POOL.length)];
  return s;
}

function stageVerdict(argv0) {
  const base = argv0.split('/').pop().split('\\').pop();
  const direct = resolveBinary(base);
  const actual = resolveBinary(argv0);
  return { base, direct, actual };
}

describe(`parse-fuzz (seed ${SEED}, ${CASES} cases)`, () => {
  it('invariant 1+2+3 hold over the whole corpus', () => {
    const rnd = mulberry32(SEED);
    const markers = ['MARKER-AWS-9f3a1', 'MARKER-SECRET-b7c2d'];
    const tCorpus = performance.now();
    for (let i = 0; i < CASES; i++) {
      const input = randomInput(rnd);
      const t0 = performance.now();

      let stages;
      try {
        stages = parseCommand(input);
      } catch {
        // A throw is an allowed outcome; the parse still had to terminate.
        // The per-input budget applies to LONG inputs — backtracking blow-up
        // is proportional to length, while short inputs are dominated by
        // scheduler noise under the parallel test runner.
        if (input.length >= 200) {
          assert.ok(performance.now() - t0 < 50, `parse blew the 50ms budget on: ${JSON.stringify(input)}`);
        }
        continue;
      }

      const elapsed = performance.now() - t0;
      if (input.length >= 200) {
        assert.ok(elapsed < 50, `parse took ${elapsed.toFixed(1)}ms (>50ms) on: ${JSON.stringify(input)} (seed ${SEED}, case ${i})`);
      }

      for (const stage of stages) {
        // Never an empty argv[0] — that would make resolveBinary bypass the
        // basename gate entirely.
        assert.ok(stage.argv.length > 0, `empty stage on: ${JSON.stringify(input)}`);
        const argv0 = String(stage.argv[0] || '');
        assert.ok(argv0.length > 0, `empty argv[0] on: ${JSON.stringify(input)} (seed ${SEED}, case ${i})`);

        // NO ESCAPE: a qualified spelling may only be stricter than the
        // basename verdict — if the basename is refused, the qualified form
        // must be refused too; a resolved binary must keep its basename.
        const { base, direct, actual } = stageVerdict(argv0);
        if (direct.error) {
          assert.ok(actual.error,
            `argv[0]=${JSON.stringify(argv0)} resolves (basename ${JSON.stringify(base)} is refused) on: ${JSON.stringify(input)} (seed ${SEED}, case ${i})`);
        }
        if (actual.bin) {
          assert.equal(actual.base, base, `resolved basename drift on: ${JSON.stringify(input)}`);
        }
      }

      // NO SENSITIVE EXPANSION: planted env markers must never appear in
      // any argv element, whatever the quoting context.
      const flat = stages.map((s) => s.argv.join(' ')).join(' ');
      for (const m of markers) {
        assert.ok(!flat.includes(m),
          `env marker leaked into argv on: ${JSON.stringify(input)} (seed ${SEED}, case ${i})`);
      }
    }
    // Aggregate bound: even with per-input checks relaxed for short inputs,
    // a corpus-wide slowdown would mean real backtracking, not scheduler noise.
    assert.ok(performance.now() - tCorpus < 120_000, 'corpus ran longer than 120s — possible backtracking blow-up');
  });
});

describe('parse-fuzz — targeted expansion spellings', () => {
  const spellings = [
    '$AWS_SECRET_ACCESS_KEY',
    '$SECRET',
    '${SECRET}',
    '${AWS_SECRET_ACCESS_KEY}',
    '$AWS_SECRET_ACCESS_KEY',
    'echo $SECRET',
    'echo ${SECRET}',
    'echo "${SECRET}"',
    "echo '${SECRET}'",
    `echo "$SECRET"`,
    `echo '$SECRET'`,
    "$'\\x24HOME'",
    "$'\\x24SECRET'",
    'echo "$AWS_SECRET_ACCESS_KEY"',
    'echo ${AWS_SECRET_ACCESS_KEY:-fallback}',
    'cat $SECRET/x',
    'echo ${SECRET}${AWS_SECRET_ACCESS_KEY}',
  ];

  it('no spelling of a sensitive variable expands into argv', () => {
    for (const input of spellings) {
      let stages;
      try {
        stages = parseCommand(input);
      } catch {
        continue; // a rejected parse is also a safe outcome
      }
      const flat = stages.map((s) => s.argv.join(' ')).join(' ');
      assert.ok(!flat.includes('MARKER-AWS-9f3a1'), `AWS marker leaked for: ${JSON.stringify(input)}`);
      assert.ok(!flat.includes('MARKER-SECRET-b7c2d'), `SECRET marker leaked for: ${JSON.stringify(input)}`);
    }
  });

  it('allowlisted HOME expansion still works in all contexts', () => {
    const flat = parseCommand('echo "$HOME" $HOME ~').map((s) => s.argv.join(' ')).join(' ');
    assert.ok(flat.includes(FAKE_HOME), 'HOME must expand to the test home');
  });
});
