import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let PackageLifecycle, auditVerify;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mona-pkg-'));
const AUDIT = path.join(TMP, 'audit.jsonl');
process.env.MONA_AUDIT = AUDIT;
const p = (name) => path.join(TMP, `${name}.json`);

before(async () => ({ PackageLifecycle, auditVerify } = await import('../src/index.mjs')));

describe('PackageLifecycle install/upgrade/rollback', () => {
  it('installs and confirms a package', () => {
    const l = new PackageLifecycle({ storePath: p('a') });
    const installing = l.install('web-1', 'mona-agent', '2.0.0');
    assert.equal(installing.state, 'installing');
    assert.equal(installing.currentVersion, '2.0.0');
    const installed = l.confirm('web-1', 'mona-agent');
    assert.equal(installed.state, 'installed');
  });

  it('upgrades, fails, and rolls back to the previous version', () => {
    const l = new PackageLifecycle({ storePath: p('b') });
    l.install('web-1', 'mona-agent', '2.0.0');
    l.confirm('web-1', 'mona-agent');

    const upgrading = l.upgrade('web-1', 'mona-agent', '3.0.0');
    assert.equal(upgrading.previousVersion, '2.0.0');
    assert.equal(upgrading.currentVersion, '3.0.0');

    const failed = l.fail('web-1', 'mona-agent', { reason: 'crash on start' });
    assert.equal(failed.state, 'rollback_required');

    const rolled = l.rollback('web-1', 'mona-agent', { reason: 'bad version' });
    assert.equal(rolled.state, 'rolled_back');
    assert.equal(rolled.currentVersion, '2.0.0', 'previous version restored');
    assert.equal(rolled.previousVersion, '');
  });

  it('rejects invalid transitions and refuses rollback without a previous version', () => {
    const l = new PackageLifecycle({ storePath: p('c') });
    assert.throws(() => l.upgrade('web-1', 'mona-agent', '2.0.0'), /cannot upgrade from absent/);
    l.install('web-1', 'mona-agent', '2.0.0');
    assert.throws(() => l.rollback('web-1', 'mona-agent'), /cannot roll back from installing/);
  });

  it('persists across restart and audits lifecycle transitions', () => {
    const pth = p('d');
    const a = new PackageLifecycle({ storePath: pth });
    a.install('web-1', 'mona-agent', '2.0.0');
    a.confirm('web-1', 'mona-agent');
    a.upgrade('web-1', 'mona-agent', '3.0.0');
    a.fail('web-1', 'mona-agent', { reason: 'x' });
    a.rollback('web-1', 'mona-agent', { reason: 'x' });

    const b = new PackageLifecycle({ storePath: pth });
    assert.equal(b.get('web-1', 'mona-agent').state, 'rolled_back');

    const audit = auditVerify(AUDIT);
    assert.equal(audit.ok, true);
    assert.ok(audit.checked >= 4, 'install/upgrade/rollback transitions are audited');
  });
});
