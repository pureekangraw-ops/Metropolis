# Metropolis integration ownership

Status: implementation plan, NOT live E2E acceptance.

Metropolis is the connection environment and authorized routing boundary, not owner of Factory, Observatory or Greenhouse domain truth.

## Migration sequence
1. Inventory existing direct Observatory/Factory/Greenhouse links and credentials; do not revoke live routes yet.
2. Define per-system capabilities and exact operations; validate actor, BIG delegation, Work ID, Checkpoint ID and destination before dispatch.
3. Route Factory execution to Factory Station and Greenhouse inference to its own provider runtime; Observatory receives read-only projections.
4. Correlate receipts, evidence and readback; fail closed on missing or contradictory evidence.
5. Test live end-to-end including failures, retries, cancellation and offline mode.
6. Cut over each route separately; retire direct legacy links only after parity and rollback checks.

Never transfer raw credentials in Work or logs. Existing production systems remain unchanged until acceptance.
