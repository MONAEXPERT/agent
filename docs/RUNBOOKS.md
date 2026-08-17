# Verified Operations Runbooks

These runbooks are deliberately narrow. They do not grant tools or weaken local policy. Each action remains subject to the device policy and requires explicit human approval where configured. They are tested with static fixtures; production deployment still requires environment-specific pilot evidence.

## Disk full

1. Inspect capacity with an approved `df` invocation and identify the affected mounted volume.
2. Inspect only approved workspace/application paths. Propose candidates; do not delete based solely on age or size.
3. Obtain approval for each cleanup. Use the files tool's trash-first deletion behavior; record expected and observed free space.
4. Verify reclaimed capacity and service health. Escalate if the volume is still above its threshold.

**Success:** free-space threshold is met and the affected service remains healthy.  
**Rollback:** restore from trash where possible; otherwise escalate.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/disk-pressure/`.

## Service down

1. Capture the service manager status and recent, redacted service logs.
2. Classify the failure (configuration, dependency, resource pressure, process crash, or unknown).
3. Present a restart plan and require approval. Never restart an unrecognized service or one outside local policy.
4. Verify the manager reports active/running and check the approved external health signal.

**Success:** service is active and the selected health check succeeds.  
**Rollback/escalation:** do not loop restarts; stop after the configured attempt limit and escalate with captured evidence.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/service-down/`.

## Certificate expiry

1. Inspect certificate metadata from a supplied PEM or approved endpoint; record subject, issuer, serial, and expiry without private key material.
2. Compare expiry to the alert threshold. Renewal remains a planned, explicitly authorized operation.
3. For an expired or near-expiry certificate, create an escalation/renewal plan and require approval before any side effect.
4. Verify a replacement certificate's identity, validity interval, and deployment health.

**Success:** replacement satisfies the expected identity and expiry policy.  
**Rollback/escalation:** retain the previous known-good certificate and escalate when identity or chain verification fails.  
**Fixture evidence:** `apps/desktop/test/fixtures/runbooks/certificate-expiry/`.

## Evidence requirements

For any production pilot, retain run id, policy revision, approval decision, tool attempts, before/after observations, verification result, and recovery/rollback decision. The durable run ledger is the local source of truth for this evidence.
