// Env resolver compat shim: RA_* wins, MONA_* falls back, warns once.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { env, __resetEnvWarnings } from '../src/env.js';

const RA = 'RA_TEST_SHIM_VAR';
const LEGACY = 'MONA_TEST_SHIM_VAR';

let emitted = [];
let originalEmitWarning;

beforeEach(() => {
  delete process.env[RA];
  delete process.env[LEGACY];
  __resetEnvWarnings();
  emitted = [];
  // The node test runner intercepts the 'warning' event plumbing, so stub
  // emitWarning directly — the contract under test is that the resolver
  // calls it exactly once with a DeprecationWarning.
  originalEmitWarning = process.emitWarning;
  process.emitWarning = (message, type) => { emitted.push({ message, type }); };
});

afterEach(() => {
  process.emitWarning = originalEmitWarning;
  delete process.env[RA];
  delete process.env[LEGACY];
  __resetEnvWarnings();
});

describe('env resolver (rebrand compat shim)', () => {
  it('returns the default when neither prefix is set', () => {
    assert.equal(env('TEST_SHIM_VAR', 'fallback'), 'fallback');
    assert.equal(env('TEST_SHIM_VAR'), undefined);
    assert.equal(emitted.length, 0);
  });

  it('prefers RA_ over MONA_ when both are set', () => {
    process.env[RA] = 'new';
    process.env[LEGACY] = 'legacy';
    assert.equal(env('TEST_SHIM_VAR'), 'new');
    assert.equal(emitted.length, 0, 'no deprecation warning when RA_ is used');
  });

  it('falls back to MONA_ and warns exactly once per name', () => {
    process.env[LEGACY] = 'legacy';
    assert.equal(env('TEST_SHIM_VAR'), 'legacy');
    assert.equal(env('TEST_SHIM_VAR'), 'legacy');
    assert.equal(emitted.length, 1, 'deprecation warning fires once per name');
    assert.equal(emitted[0].type, 'DeprecationWarning');
    assert.match(emitted[0].message, /MONA_TEST_SHIM_VAR is deprecated; use RA_TEST_SHIM_VAR/);
    assert.match(emitted[0].message, /removed in v4\.0\.0/);
  });

  it('honours an explicit empty-string RA_ value (no fallback)', () => {
    process.env[RA] = '';
    process.env[LEGACY] = 'legacy';
    assert.equal(env('TEST_SHIM_VAR', 'fallback'), '');
    assert.equal(emitted.length, 0);
  });
});
