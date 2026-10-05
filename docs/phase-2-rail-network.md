# Metropolis Phase 2 — Rail Network

**Status:** implementation foundation  
**Acceptance status:** live GitHub E2E pending

## Objective

Move an Agent through `Station → Rail → OATH → Owner System` and return a Receipt plus live Readback and Evidence. The Connection Engine does not own business logic or operational truth.

## Runtime components

- **Connection Engine:** resolves Station, validates the one-to-one Station/Rail pair, checks Agent authority, advances OATH, dispatches, receives Receipt and requests Readback.
- **Station Runtime:** reports identity, credential configuration, scope, connectivity, limits and readback support as `READY`, `DEGRADED`, `DENIED`, `EXPIRED`, `UNAVAILABLE` or `UNKNOWN`.
- **OATH:** `REQUEST → ACCEPTED → DISPATCHED → RECEIPT → READBACK`; Receipt is not Success.
- **Authority Gate:** checks `WHO → CAN DO WHAT → ON WHICH STATION → FOR WHICH WORK`.
- **Failure Isolation:** every failure carries a stage: `STATION`, `AUTH`, `RAIL`, `TRANSPORT`, `DESTINATION` or `READBACK`.
- **GitHub Rail Adapter:** first destination adapter with `READ_REPOSITORY` and controlled `CREATE_BRANCH` operations. Runtime credentials are injected; they are never stored in the Rail contract.

## Boundary rules

- `1 Station = 1 Rail = 1 Credential Boundary`.
- GO and LIGHT are separate Agent identities using the same protocol.
- Agent capability, Station credential and Owner authority are separate.
- The Engine stores the travel envelope and evidence reference, not the Owner System's current state.
- A provider Receipt only proves acceptance by the provider. Live Readback is required for `VERIFIED`.
- A provider or Rail failure must not mark Metropolis or other Stations as down.

## Acceptance gate

CI is necessary but insufficient. Phase 2 is operational only after a controlled live trip proves:

```text
GO or LIGHT
  ↓
GitHub Station
  ↓
GitHub Rail
  ↓
OATH
  ↓
GitHub operation
  ↓
Receipt
  ↓
Live Readback
  ↓
Evidence
  ↓
Agent
```

The controlled test must also disable or break the GitHub Rail and show that another registered Station remains usable. Until that evidence exists, the status remains `IMPLEMENTATION FOUNDATION`, not `METROPOLIS RAIL NETWORK — OPERATIONAL`.
