// Serial task queue — tasks run one at a time, in arrival order.
//
// Before this queue existed, a task arriving while another was running would
// overwrite the daemon's "current task" state and interleave its steps with
// the running task's steps, mixing up the dashboard trace. The queue runs
// each job to completion before the next starts, and reports queue position
// so the UI always knows what is running and what is waiting.
//
// Events:
//   'queued' ({ runId, position }) — a job joined the queue
//   'start'  (job)                 — a job moved from queue to running
//   'done'   (job, error?)         — a job finished (error undefined = ok)
//
// A job is { runId, run: async (job) => ... }. The run() promise resolves
// when that job is finished; the queue never drops or reorders jobs.

import { EventEmitter } from 'node:events';

export class TaskQueue extends EventEmitter {
  #queue = [];
  #running = false;

  /** Enqueue a job. Returns the queue length after insertion (1 = running now). */
  enqueue(job) {
    this.#queue.push(job);
    // Position in the run order: the currently running job (if any) counts as
    // "ahead", plus every job queued before this one, plus itself.
    const position = (this.#running ? 1 : 0) + this.#queue.length;
    this.emit('queued', { runId: job.runId, position });
    this.#drain();
    return this.#queue.length;
  }

  async #drain() {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#queue.length) {
        const job = this.#queue.shift();
        this.emit('start', job);
        let err = undefined;
        try {
          await job.run(job);
        } catch (e) {
          err = e;
          this.emit('error', e, job);
        }
        this.emit('done', job, err);
      }
    } finally {
      this.#running = false;
    }
  }

  /** Number of jobs waiting (not counting the one running). */
  get size() { return this.#queue.length; }

  /** True while a job is being executed. */
  get running() { return this.#running; }
}
