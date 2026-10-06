# Metropolis

Metropolis is the connection environment for independent operational systems.

## Boundary

- Metropolis connects systems; it is not an operational owner.
- City Hall manages intake, return, records and data.
- Factory, PRISM and other systems own their own operations.
- Current state is read from the relevant Owner System.
- Historical state is represented by Records, Evidence and Lineage.
- There is no Central Board that mirrors every system's live state.

The first implementation slice is being developed as a contract-first foundation.

## Factory live verification

The Factory adapter verifies receipt, Work ID, ingress Checkpoint ID, Factory
Station identity, evidence, and the expected source commit together. Missing or
conflicting identity cannot produce a verified readback.

Run `scripts/live-factory-e2e.mjs` with the existing `LIVE_E2E_WORK_ID`,
`LIVE_E2E_CHECKPOINT_ID`, and exact `FACTORY_SOURCE_SHA`. The harness does not
generate replacement Work identities. It verifies only boundary handoff,
receipt persistence, and correlated readback; it does not prove domain work
completed or that Metropolis is hosted as a service.
