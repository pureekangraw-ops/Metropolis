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

## Hall agent input and projection boundaries

HERMES intake accepts only arrays of nonempty string input references; handoff
payloads must be objects. MIMIR return evidence follows the same reference
validation. Invalid input is rejected before any Work record changes.

MIMIR's imported logic module now enforces its existing field grants in context
packs and consumer projections. `fields: null` means unrestricted fields for an
allowed consumer; `fields: []` permits none. Packs use the intersection of their
accessible records' grants, including summaries, titles, record IDs, warnings,
and evidence references. Route hints require permission for route evidence too.
A denied consumer receives no source, evidence, route or record identity.

Validation is covered by `test/hall-agents.test.mjs`. This is deterministic
policy development, not model fine-tuning. The imported HERMES legacy Mission
module still has unresolved legacy imports and is not wired into the MCP
runtime; MIMIR's projection module is also not exposed as a live tool. These
changes do not establish new authority, deployment or owner completion proof.
