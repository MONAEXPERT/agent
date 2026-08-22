// RemoteAgent engine — the lightweight agent core.
//
// Policy-as-code, budget governor, structured memory, bounded task loop.
// Zero runtime dependencies; every piece is unit-testable offline.
//
// The control-plane library was split out (packages/control-plane): fleet,
// JIT access, admin API, upgrades, package lifecycle, plugin signing,
// evidence/SIEM, marketplace index and metrics live there now. What stays
// here is what the device daemon actually imports — nothing below may
// import the server library back (CI enforces it).

export { Policy, PRESETS, auditWrite, auditVerify } from './policy.js';
export { AUDIT_DOMAIN, signAuditHash, verifyAuditHash, loadOrCreateAuditKey, keyPathFor, auditHead, anchorDue, compareAnchors } from './audit-sign.js';
export { verifyCapabilityGrant, resolveCapabilityGrant, intersectCapabilities, grantSigningInput, GRANT_DOMAIN } from './capability-grant.js';
export { Budget } from './budget.js';
export { MemoryStore } from './memory.js';
export { TaskLoop, parseBrainReply, compactMessages, normaliseToolResult } from './loop.js';
export { runSubtasks, buildSubSystemPrompt, MAX_SUBTASKS, MAX_SUB_PROMPT, MAX_SUB_STEPS } from './delegate.js';
export { runWorkflow, validatePhases, buildPhaseContext, MAX_PHASES } from './workflow.js';
export { GoalStore, parseGoalMarker, buildGoalRoundPrompt, goalRoundTaskText, normaliseGoal, MAX_GOAL_ROUNDS, MAX_OBJECTIVE } from './goal.js';
export { RunStore, RUN_STATE, normaliseRun, retryDecision, RUN_STATUSES, ACTIVE_RUN_STATUSES, TERMINAL_RUN_STATUSES } from './run-state.js';
export { DeviceRegistry, DEVICE_HEALTH, hashCredential, normaliseDevice, generateDeviceIdentity, generateCredential, signEnrollment, verifyEnrollment, canonical } from './device-registry.js';
export { hashManifest, generateSigningKeyPair, normalisePluginManifest, signManifest, verifyManifest, checkCapabilities } from './plugin-manifest.js';
export { VectorStore, embed, cosine, tokenize, hashString, hashString2, VECTOR_DIM } from './vector.js';

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
