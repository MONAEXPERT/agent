// Network integration — the ONE test in the repo that dials out for real.
//
// Excluded from the default `npm test` run (see scripts/run-tests.mjs):
// the security suite must stay hermetic so it can run in air-gapped CI,
// corporate proxies, and customer pipelines. Run explicitly with:
//
//   RA_NETWORK_TESTS=1 npm test -- network-integration
//
// Connectivity failures (offline runner, blocked egress) are tolerated;
// an unexpected response (e.g. an intercepting proxy answering 403) is a
// real signal and fails the run.
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-netit-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');

const { net } = await import('../src/tools/net.js');

describe('network integration (opt-in)', () => {
  before(function () {
    if (process.env.RA_NETWORK_TESTS !== '1') {
      this.skip('RA_NETWORK_TESTS=1 required; excluded from the default suite');
    }
  });

  it('fetches a public site end-to-end (network)', async () => {
    try {
      const r = await net.run({ action: 'fetch', url: 'https://example.com' });
      if (r.error) {
        // Offline / blocked network: tolerate connectivity failures only.
        if (/timed out|ENOTFOUND|getaddrinfo|network/i.test(r.error)) return;
        assert.fail(`unexpected error: ${r.error}`);
      }
      assert.equal(r.status, 200);
      assert.ok(r.body.length > 0);
    } catch (err) {
      if (/timed out|ENOTFOUND|getaddrinfo/i.test(err.message)) return;
      throw err;
    }
  });
});
