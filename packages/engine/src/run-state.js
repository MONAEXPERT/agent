// Durable execution state for side-effect-aware agent runs.
//
// RunStore is deliberately independent from any provider, queue, or tool
// implementation. It persists only owned JSON data through atomic 0600 writes,
// making it safe to use for task orchestration, CLI work, or cloud requests.
// It provides a conservative retry decision: a side effect never becomes
// retryable merely because a process restarted.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const DEFAULT_STORE = process.env.MONA_RUNS_STORE || join(homedir(), '.mona-agent', 'runs.json');
const MAX_RUNS = 500;
const MAX_TEXT = 4000;
const ACTIVE = new Set(['created', 'planned', 'awaiting_approval', 'running', 'verifying', 'rollback_required']);
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'rolled_back']);
const TRANSITIONS = {
  created: new Set(['planned', 'awaiting_approval', 'running', 'cancelled', 'failed']),
  planned: new Set(['awaiting_approval', 'running', 'cancelled', 'failed']),
  awaiting_approval: new Set(['planned', 'running', 'cancelled', 'failed']),
  running: new Set(['verifying', 'succeeded', 'failed', 'cancelled', 'rollback_required']),
  verifying: new Set(['succeeded', 'failed', 'rollback_required']),
  rollback_required: new Set(['rolled_back', 'failed']),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), rolled_back: new Set(),
};
const _instances = new Map();

function nowIso() { return new Date().toISOString(); }
function truncate(value, n = MAX_TEXT) { return String(value ?? '').slice(0, n); }
function runId() { return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`; }
function eventId() { return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }

export function normaliseRun(raw = {}) {
  const status = TRANSITIONS[raw.status] ? raw.status : 'created';
  const attempts = Array.isArray(raw.attempts) ? raw.attempts.slice(-200).map((a) => ({
    id: String(a?.id || eventId()),
    tool: truncate(a?.tool, 200),
    idempotencyKey: truncate(a?.idempotencyKey, 300),
    sideEffects: Boolean(a?.sideEffects),
    idempotent: Boolean(a?.idempotent),
    compensation: Boolean(a?.compensation),
    status: ['started', 'succeeded', 'failed', 'unknown', 'compensated'].includes(a?.status) ? a.status : 'unknown',
    result: a?.result && typeof a.result === 'object' ? a.result : null,
    ts: a?.ts || nowIso(),
    updatedAt: a?.updatedAt || a?.ts || nowIso(),
  })) : [];
  return {
    id: String(raw.id || runId()),
    task: truncate(raw.task, MAX_TEXT),
    status,
    correlationId: truncate(raw.correlationId || raw.id || '', 300),
    policyRevision: truncate(raw.policyRevision, 200),
    planRevision: truncate(raw.planRevision, 200),
    checkpoint: raw.checkpoint && typeof raw.checkpoint === 'object' ? raw.checkpoint : {},
    approvals: Array.isArray(raw.approvals) ? raw.approvals.slice(-100) : [],
    attempts,
    reason: truncate(raw.reason, 1000),
    createdAt: raw.createdAt || nowIso(),
    updatedAt: raw.updatedAt || nowIso(),
  };
}

export function retryDecision(attempt) {
  if (!attempt) return { retryable: true, reason: 'no prior attempt' };
  if (!attempt.sideEffects) return { retryable: true, reason: 'read-only attempt' };
  if (attempt.status === 'succeeded') return { retryable: false, reason: 'side effect already succeeded' };
  if (attempt.idempotent && attempt.idempotencyKey) return { retryable: true, reason: 'idempotent side effect with key' };
  if (attempt.compensation && attempt.status === 'compensated') return { retryable: true, reason: 'prior effect compensated' };
  return { retryable: false, reason: 'side effect requires idempotency key or completed compensation' };
}

export class RunStore {
  constructor({ storePath = DEFAULT_STORE } = {}) {
    const existing = _instances.get(storePath);
    if (existing) return existing;
    this.storePath = storePath;
    this.runs = new Map();
    this.#load();
    _instances.set(storePath, this);
  }

  #load() {
    try {
      if (!existsSync(this.storePath)) return;
      const raw = JSON.parse(readFileSync(this.storePath, 'utf8'));
      for (const item of (Array.isArray(raw?.runs) ? raw.runs : [])) {
        const run = normaliseRun(item);
        this.runs.set(run.id, run);
      }
    } catch { /* unavailable/corrupt state fails closed to an empty store */ }
  }

  #save() {
    mkdirSync(dirname(this.storePath), { recursive: true });
    const runs = [...this.runs.values()].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, MAX_RUNS);
    const tmp = `${this.storePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, runs }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.storePath);
  }

  #put(run) {
    const fresh = normaliseRun({ ...run, updatedAt: nowIso() });
    this.runs.set(fresh.id, fresh);
    this.#save();
    return this.get(fresh.id);
  }

  create({ id, task, correlationId, policyRevision = '', planRevision = '', checkpoint = {} } = {}) {
    const run = normaliseRun({ id, task, correlationId, policyRevision, planRevision, checkpoint, status: 'created' });
    if (this.runs.has(run.id)) return this.get(run.id);
    return this.#put(run);
  }

  get(id) {
    const run = this.runs.get(String(id));
    return run ? normaliseRun(run) : null;
  }

  list({ activeOnly = false } = {}) {
    return [...this.runs.values()]
      .filter((r) => !activeOnly || ACTIVE.has(r.status))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((r) => normaliseRun(r));
  }

  transition(id, status, { reason = '', checkpoint } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!TRANSITIONS[status]) throw new TypeError(`unknown run status: ${status}`);
    if (run.status !== status && !TRANSITIONS[run.status].has(status)) {
      throw new Error(`invalid run transition: ${run.status} → ${status}`);
    }
    run.status = status;
    if (reason) run.reason = truncate(reason, 1000);
    if (checkpoint && typeof checkpoint === 'object') run.checkpoint = checkpoint;
    return this.#put(run);
  }

  checkpoint(id, checkpoint) {
    const run = this.get(id);
    if (!run) return null;
    run.checkpoint = checkpoint && typeof checkpoint === 'object' ? checkpoint : {};
    return this.#put(run);
  }

  approve(id, { actor = '', decision = 'approved', expiresAt = '', note = '' } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!['approved', 'rejected', 'expired'].includes(decision)) throw new TypeError('invalid approval decision');
    run.approvals.push({ actor: truncate(actor, 300), decision, expiresAt: truncate(expiresAt, 100), note: truncate(note, 1000), ts: nowIso() });
    return this.#put(run);
  }

  startAttempt(id, { tool, idempotencyKey = '', sideEffects = false, idempotent = false, compensation = false } = {}) {
    const run = this.get(id);
    if (!run) return null;
    if (!tool) throw new TypeError('attempt tool is required');
    // A freshly requested side effect must declare an idempotency key before
    // execution. It may still be non-idempotent, but then any interrupted
    // attempt is deliberately sent to manual review rather than retried.
    if (sideEffects && !idempotencyKey) throw new Error('side-effecting attempt requires an idempotency key');
    const prior = run.attempts.find((a) => a.idempotencyKey && a.idempotencyKey === idempotencyKey && a.tool === tool && a.status !== 'compensated');
    const decision = retryDecision(prior);
    if (!decision.retryable) throw new Error(`unsafe retry refused: ${decision.reason}`);
    const attempt = normaliseRun({ attempts: [{ tool, idempotencyKey, sideEffects, idempotent, compensation, status: 'started' }] }).attempts[0];
    run.attempts.push(attempt);
    this.#put(run);
    return { run: this.get(id), attempt, decision };
  }

  finishAttempt(id, attemptId, { status = 'succeeded', result = null } = {}) {
    const run = this.get(id);
    if (!run) return null;
    const attempt = run.attempts.find((a) => a.id === attemptId);
    if (!attempt) return null;
    if (!['succeeded', 'failed', 'unknown', 'compensated'].includes(status)) throw new TypeError('invalid attempt status');
    attempt.status = status;
    attempt.result = result && typeof result === 'object' ? result : null;
    attempt.updatedAt = nowIso();
    return this.#put(run);
  }

  recoverable() {
    return this.list({ activeOnly: true }).map((run) => {
      const incomplete = run.attempts.filter((a) => a.status === 'started' || a.status === 'unknown');
      const unsafe = incomplete.filter((a) => !retryDecision(a).retryable);
      return { run, action: unsafe.length ? 'manual_review' : 'resume', reason: unsafe.length ? 'unfinished side effect lacks safe retry contract' : 'all unfinished work is safe to resume' };
    });
  }

  remove(id) {
    const existed = this.runs.delete(String(id));
    if (existed) this.#save();
    return existed;
  }
}

export const RUN_STATUSES = Object.freeze([...Object.keys(TRANSITIONS)]);
export const ACTIVE_RUN_STATUSES = Object.freeze([...ACTIVE]);
export const TERMINAL_RUN_STATUSES = Object.freeze([...TERMINAL]);
