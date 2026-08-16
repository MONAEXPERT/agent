// mona engine — the lightweight agent core.
//
// Policy-as-code, budget governor, structured memory, bounded task loop.
// Zero runtime dependencies; every piece is unit-testable offline.

export { Policy } from './policy.js';
export { Budget } from './budget.js';
export { MemoryStore } from './memory.js';
export { TaskLoop, parseBrainReply } from './loop.js';

/**
 * One-call engine wiring with sensible defaults.
 * think(messages, {profile, temperature}) is provided by the caller
 * (any provider/brain); runTool(name, args) executes sandboxed tools.
 */
export function createEngine({ think, runTool, policyPath, storePath, budget } = {}) {
  const policy = policyPath ? Policy.load(policyPath) : new Policy(null);
  const b = budget instanceof Budget ? budget : new Budget(budget || {});
  const memory = new MemoryStore({ storePath });
  const loop = new TaskLoop({ think, runTool, policy, budget: b });
  return { policy, budget: b, memory, loop };
}
