export class RunStore {
  constructor(){ this.runs = new Map(); }
  createRun(id, meta) {
    if(this.runs.has(id)) throw new Error(`Run ${id} exists`);
    const r = { id, meta, state: "created", checkpoints: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.runs.set(id, r);
    return r;
  }
  checkpoint(id, data){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); const cp = { ts: Date.now(), data }; r.checkpoints.push(cp); r.currentCheckpoint = cp; r.updatedAt = Date.now(); return cp; }
  restore(id, index){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); const cp = r.checkpoints[index]; if(!cp) throw new Error(`Invalid checkpoint`); r.currentCheckpoint = cp; r.updatedAt = Date.now(); return cp; }
  cancel(id){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); r.state = "cancelled"; r.updatedAt = Date.now(); return r.state; }
  retry(id){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); r.state = "retrying"; r.updatedAt = Date.now(); return r.state; }
  complete(id){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); r.state = "completed"; r.updatedAt = Date.now(); return r.state; }
  status(id){ const r = this.runs.get(id); if(!r) throw new Error(`Run ${id} not found`); return { id: r.id, state: r.state, meta: r.meta, createdAt: r.createdAt, updatedAt: r.updatedAt, checkpoints: r.checkpoints.length, currentCheckpoint: r.currentCheckpoint }; }
}
