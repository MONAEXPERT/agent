import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

describe('verified operations runbooks', () => {
  it('ships disk, service, and certificate safety instructions', () => {
    const runbooks = read('../../docs/RUNBOOKS.md');
    assert.match(runbooks, /Disk full/);
    assert.match(runbooks, /Service down/);
    assert.match(runbooks, /Certificate expiry/);
    assert.match(runbooks, /approval/i);
    assert.match(runbooks, /Rollback|escalation/i);
  });

  it('ships non-autonomous service and certificate skills', () => {
    for (const file of ['skills/service-health/SKILL.md', 'skills/certificate-expiry/SKILL.md']) {
      const skill = read(file);
      assert.match(skill, /^---/);
      assert.match(skill, /explicit approval/i);
      assert.match(skill, /local.policy|local-policy|local policy/i);
    }
  });

  it('includes a static disk-pressure fixture for offline acceptance work', () => {
    const fixture = read('test/fixtures/runbooks/disk-pressure/df-p.txt');
    assert.match(fixture, /93%/);
    assert.match(fixture, /\/data/);
  });
});
