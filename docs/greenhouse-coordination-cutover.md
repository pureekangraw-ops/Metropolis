# Greenhouse coordination cutover — owner-approved direction

Status: IMPLEMENTATION PENDING / NO PRODUCTION ROUTE CHANGE
Owner decision: All future orchestration must pass through Greenhouse. Factory remains a downstream executor, not the direct coordination target.

## Target route
GO / LIGHT -> Metropolis (identity, Work, Checkpoint, authorization) -> Greenhouse (coordination) -> downstream tools including Factory -> verified return / readback to Metropolis.

## Required cutover gates
1. Inventory existing FACTORY_STATION routes, active Work, and all in-flight dispatches.
2. Register and authenticate Greenhouse as a bounded station; prove delegated authority and Work/Checkpoint correlation.
3. Implement Greenhouse dispatch and receipt forwarding with idempotency, retries, audit, timeout, and explicit failures.
4. Verify real end-to-end Work -> Greenhouse -> Factory -> receipt -> owner-source readback.
5. Drain or safely reconcile existing direct Factory journeys; ensure no duplicate handoff.
6. Disable direct Factory dispatch only after live proof and owner-approved rollback readiness.
7. Verify production route readback and preserve Factory's technical executor role.

## Safety invariants
- Metropolis remains Work lifecycle and authorization source of truth.
- Greenhouse cannot mint Work IDs, approvals, or evidence of execution.
- Factory cannot be silently disconnected while in-flight Work exists.
- Missing auth, Work Pass, checkpoint, source readback, or endpoint => fail closed.
- Draft PR only; no merge, deploy, DNS, secret, or live route mutation in this change.

## Acceptance
- Greenhouse route explicitly registered and observed in live routing.
- Direct Metropolis -> Factory new handoff blocked; legacy in-flight journeys resolved.
- Test receipt proves same Work ID and Checkpoint end-to-end.
- Negative tests: unauthorized actor, replay, duplicate, stale grant, timeout, missing evidence.
