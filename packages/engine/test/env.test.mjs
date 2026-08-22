// Env resolver compat shim: RA_* wins, MONA_* falls back, warns once.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { env, __resetEnvWarnings } from '../src/env.js';

const RA = 'RA_TEST_SHIM_VAR';
const LEGACY = 'MONA_TEST_SHIM_VAR';

beforeEach(() => {
  delete process.env[RA];
  delete process.env[LEGACY];
  __resetEnvWarnings();
});

afterEach(() => {
  delete process.env[RA];
  delete process.env[LEGACY];
  __resetEnvWarnings();
});

describe('env resolver (rebrand compat shim)', () => {
  it('returns the default when neither prefix is set', () => {
    assert.equal(env('TEST_SHIM_VAR', 'fallback'), 'fallback');
    assert.equal(env('TEST_SHIM_VAR'), undefined);
  });

  it('prefers RA_ over MONA_ when both are set', () => {
    process.env[RA] = 'new';
    process.env[LEGACY] = 'legacy';
    const warnings = [];
    const onWarn = (w) => warnings.push(w);
    process.on('warning', onWarn);
    try {
      assert.equal(env('TEST_SHIM_VAR'), 'new');
      assert.equal(warnings.length, 0, 'no deprecation warning when RA_ is used');
    } finally {
      process.off('warning', onWarn);
    }
  });

  it('falls back to MONA_ and warns exactly once per name', () => {
    process.env[LEGACY] = 'legacy';
    const warnings = [];
    const onWarn = (w) => warnings.push(w);
    process.on('warning', onWarn);
    try {
      assert.equal(env('TEST_SHIM_VAR'), 'legacy');
      assert.equal(env('TEST_SHIM_VAR'), 'legacy');
      const deprecations = warnings.filter((w) => w.name === 'DeprecationWarning');
      assert.equal(deprecations.length, 1);
      assert.match(deprecations[0].message, /MONA_TEST_SHIM_VAR is deprecated; use RA_TEST_SHIM_VAR/);
      assert.match(deprecations[0].message, /removed in v4\.0\.0/);
    } finally {
      process.off('warning', onWarn);
    }
  });

  it('honours an explicit empty-string RA_ value (no fallback)', () => {
    process.env[RA] = '';
    process.env[LEGACY] = 'legacy';
    assert.equal(env('TEST_SHIM_VAR', 'fallback'), '');
  });
});
