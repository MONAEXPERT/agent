// Doctor — pure checks + report formatting (network-free parts).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-doctor-'));
process.env.HOME = FAKE_HOME;
process.env.MONA_WORKSPACE = path.join(FAKE_HOME, 'workspace');
fs.mkdirSync(process.env.MONA_WORKSPACE, { recursive: true });
fs.mkdirSync(path.join(FAKE_HOME, '.remoteagent'), { recursive: true });
fs.writeFileSync(path.join(FAKE_HOME, '.remoteagent', 'credentials.json'), JSON.stringify({ apiKey: 'k', agentId: 'a1' }));
process.env.MONA_POLICY = path.join(FAKE_HOME, '.remoteagent', 'policy.json');
fs.writeFileSync(process.env.MONA_POLICY, JSON.stringify({ version: 1, tools: {} }));

const doctor = await import('../src/doctor.js');

describe('doctor checks', () => {
  it('checkNodeVersion gates on >= 20', () => {
    assert.equal(doctor.checkNodeVersion('v20.0.0').ok, true);
    assert.equal(doctor.checkNodeVersion('v18.0.0').ok, false);
    assert.equal(doctor.checkNodeVersion('v24.1.0').ok, true);
  });

  it('checkDirState reports writable dirs', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'remoteagent-doctor-w-'));
    assert.equal(doctor.checkDirState(d, 'x').ok, true);
    assert.equal(doctor.checkDirState(path.join(d, 'missing'), 'x').ok, false);
  });

  it('checkFileState reports presence', () => {
    assert.equal(doctor.checkFileState(process.env.MONA_POLICY, 'policy').ok, true);
    assert.equal(doctor.checkFileState(path.join(FAKE_HOME, 'nope'), 'nope').ok, false);
  });

  it('runDoctor with injected fetcher assembles a report', async () => {
    const report = await doctor.runDoctor({
      fetcher: async () => ({ status: 200 }),
      skipUpdate: true,
      nodeVersion: 'v22.0.0',
    });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    assert.equal(byName.node.ok, true);
    assert.equal(byName.credentials.ok, true);
    assert.equal(byName.policy.ok, true);
    assert.equal(byName.workspace.ok, true);
    assert.equal(byName.cloud.ok, true);
    assert.equal(byName.update.ok, true);
    assert.equal(byName.provider.ok, true);
    assert.equal(report.healthy, true);
    const text = doctor.formatDoctor(report);
    assert.match(text, /All checks passed\./);
  });

  it('audit verify failure does not crash the report', async () => {
    const report = await doctor.runDoctor({
      fetcher: async () => { throw new Error('down'); },
      skipUpdate: true,
      nodeVersion: 'v22.0.0',
    });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    assert.equal(byName.cloud.ok, false);
  });

  it('sandbox line reports availability per backend', async () => {
    const report = await doctor.runDoctor({
      fetcher: async () => ({ status: 200 }),
      skipUpdate: true,
      nodeVersion: 'v22.0.0',
      sandbox: { backend: 'bwrap', available: true },
      mode: 'standard',
    });
    const byName = Object.fromEntries(report.checks.map((c) => [c.name, c]));
    assert.equal(byName.sandbox.ok, true);
    assert.match(byName.sandbox.detail, /bwrap/);
    assert.equal(report.healthy, true);
  });

  it('sandbox unavailable is a failure ONLY in full mode', async () => {
    const base = {
      fetcher: async () => ({ status: 200 }),
      skipUpdate: true,
      nodeVersion: 'v22.0.0',
      sandbox: { backend: null, available: false, reason: 'bwrap not found' },
    };
    const std = await doctor.runDoctor({ ...base, mode: 'standard' });
    const stdByName = Object.fromEntries(std.checks.map((c) => [c.name, c]));
    assert.equal(stdByName.sandbox.ok, true, 'standard mode tolerates a missing sandbox');
    assert.equal(std.healthy, true);

    const full = await doctor.runDoctor({ ...base, mode: 'full' });
    const fullByName = Object.fromEntries(full.checks.map((c) => [c.name, c]));
    assert.equal(fullByName.sandbox.ok, false, 'full mode requires the sandbox');
    assert.match(fullByName.sandbox.detail, /required by full mode/);
    assert.equal(full.healthy, false);
  });
});
