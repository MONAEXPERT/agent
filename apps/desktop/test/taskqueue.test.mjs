// Tests for the serial task queue — tasks run one at a time, in order.

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let TaskQueue;

before(async () => {
  ({ TaskQueue } = await import('../src/taskqueue.js'));
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('TaskQueue', () => {
  it('runs jobs serially in arrival order', async () => {
    const q = new TaskQueue();
    const order = [];
    const done = [];
    q.enqueue({ runId: 'a', run: async () => { order.push('a-start'); await delay(30); order.push('a-end'); } });
    q.enqueue({ runId: 'b', run: async () => { order.push('b-start'); await delay(5); order.push('b-end'); } });
    q.enqueue({ runId: 'c', run: async () => { order.push('c-start'); order.push('c-end'); } });
    q.on('done', (job) => done.push(job.runId));
    await delay(150);
    assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
    assert.deepEqual(done, ['a', 'b', 'c']);
    assert.equal(q.running, false);
    assert.equal(q.size, 0);
  });

  it('reports queue position and continues after a failing job', async () => {
    const q = new TaskQueue();
    const positions = [];
    const errors = [];
    q.on('queued', ({ position }) => positions.push(position));
    q.on('error', (err) => errors.push(err.message));
    const ran = [];
    q.enqueue({ runId: 'x', run: async () => { throw new Error('boom'); } });
    q.enqueue({ runId: 'y', run: async () => { ran.push('y'); } });
    await delay(80);
    assert.deepEqual(positions, [1, 2]);
    assert.deepEqual(errors, ['boom']);
    assert.deepEqual(ran, ['y']);
    assert.equal(q.running, false);
  });

  it('enqueuing during a run does not skip or reorder', async () => {
    const q = new TaskQueue();
    const order = [];
    q.enqueue({ runId: '1', run: async () => { order.push('1'); await delay(30); order.push('1-done'); } });
    // enqueue two more while the first is still running
    await delay(10);
    q.enqueue({ runId: '2', run: async () => { order.push('2'); } });
    q.enqueue({ runId: '3', run: async () => { order.push('3'); } });
    await delay(120);
    assert.deepEqual(order, ['1', '1-done', '2', '3']);
  });
});
