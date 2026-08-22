// RemoteAgent control-plane library — server-side management modules.
//
// NOT active on the device: the desktop daemon imports nothing from this
// package (CI enforces that with a grep guard). These modules serve the
// control plane / fleet side: policy registries, JIT access, fleet
// management, upgrades, package lifecycle, plugin signing, evidence and
// SIEM export, marketplace index, metrics. They depend on @remoteagent/engine
// for the shared primitives (Policy, audit, RunStore, DeviceRegistry).

export { PolicyRegistry, normalisePolicyRevision } from './policy-registry.js';
export { JitAccess, ROLES, normaliseGrant } from './jit.js';
export { computeRunMetrics, evaluateAlerts } from './metrics.js';
export { UpgradeOrchestrator, UPGRADE_STATES, normaliseUpgrade } from './upgrade.js';
export { FleetController } from './fleet.js';
export { buildRunEvidence, readAuditEntries, queryAudit } from './evidence.js';
export { PackageLifecycle, PKG_STATES, normalisePackage, verifyPackageArtifact } from './package-lifecycle.js';
export { toNdjson, exportAuditNdjson, exportRunEvidenceNdjson } from './siem.js';
export { AdminApi } from './admin-api.js';
export { normaliseMarketplaceIndex, hashMarketplaceIndex, signMarketplaceIndex, verifyMarketplaceIndex } from './marketplace-index.js';
