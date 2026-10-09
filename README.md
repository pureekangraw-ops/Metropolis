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


## GO / LIGHT capability parity

GO and LIGHT use separate authenticated identities and separate audit lineage, but
identity separation does not reduce operational capability. Within an authorized
Work, both actors may use HERMES Reception and receive the same persisted Work
Pass actions: read, handoff, return, cancel and complete.

Role differences are workflow responsibilities, not access tiers. LIGHT may carry
implementation through the operational route; GO may review/audit/decide. Final
irreversible gates such as merge, final release or final acceptance remain subject
to the explicit GO/BIG review policy of the owning system.

`SAME CAPABILITY != SAME ROLE`  
`IDENTITY SEPARATION != CAPABILITY REDUCTION`


## Work-state signal line

City Hall keeps a lightweight live projection for Work availability. HERMES is
the only publisher that announces a Work ONLINE (new or resumed), and MIMIR is
the only publisher that announces it OFFLINE (cancelled or completed).

A work-state signal carries only Work ID, Checkpoint ID, ONLINE/OFFLINE status,
the Work state at announcement time, publisher, sequence, reason and timestamp.
It does not carry context, files, artifacts or other cargo. Heavy data continues
through PIXIE/cargo paths.

`SIGNAL != CONTEXT != CARGO`  
`HERMES -> ONLINE`  
`MIMIR -> OFFLINE`

## Tool-to-tool travel and delegated operating authority (target contract)

**Status: design contract; not a claim that every route is implemented or verified.**
This section defines who may travel to a connected tool, who may operate it,
and what evidence must come back. It does not assign ownership of domain truth
to Metropolis.

- **BIG / owner:** may connect and authorize tools and agents, delegate operating
  authority, revoke access, and direct authorized lifecycle controls.
- **GO / LIGHT / owner-authorized agents:** may discover, travel to, read from,
  or command connected tools within BIG's explicit delegation and the owning
  system's supported operations. Identity must be attributable to the real
  initiating actor, including when acting on BIG's behalf.
- **Metropolis / City Hall:** may initiate authenticated outbound tool calls,
  accept authenticated inbound agent connections, route commands, fetch
  authorized results, and correlate receipts/readbacks. It must authorize
  the operation **before dispatch**, not merely authorize a connection.
- **Resident tool agents:** may receive validated commands and return status,
  evidence, artifacts and incidents; may initiate authenticated callbacks
  or incident reporting. A connection or callback is not a grant of new authority.

### Route != capability != authority

Each participating app declares: (1) supported inbound/outbound routes,
(2) capabilities and owner-of-truth boundaries, (3) accepted delegated
authority, (4) request/response/error contract, (5) lifecycle and recovery,
and (6) audit/readback. Read, observe, execute, pause, resume, cancel,
return and complete are distinct operations; availability is not permission.

The city's central gate validates **actor identity + BIG delegation +
target tool + operation + Work/Checkpoint context** before dispatch.
The destination authenticates the city/agent, verifies command integrity,
contract support and operational safety; it must not invent a second
independent user-authorization policy for the same grant. Existing
owner-specific irreversible approval gates remain in force.

Metropolis may use provider-supported OAuth, service credentials and
refresh-token rotation where legitimately issued to Metropolis; keep
credentials server-side, never forward raw credentials in Work,
receipts or logs, and never reuse ChatGPT session tokens.
Expired/revoked credentials fail closed and require reauthorization if
refresh is not available. Browser-based authorization may bootstrap a
connection but is not a substitute for machine-to-machine execution.

All attempts, **including reads, denied operations, outbound dispatch,
callbacks, token refresh outcomes and readback**, must be auditable with
actor, BIG delegation, target, operation, timestamp, Work/Checkpoint
correlation and outcome. Redact secrets. A request accepted for dispatch
is not evidence that the owning tool executed it or that the Work is done.

Lifecycle requests must follow the owning system's supported safe
checkpoint semantics. PAUSE holds recoverable state; RESUME continues;
CANCEL returns available state/artifacts and reports incomplete returns
explicitly. Preserve ownership, evidence and lineage:
`REQUESTED != ACCEPTED != EXECUTED != VERIFIED != DONE`.

Tool-to-tool processing should continue in the responsible backend or
resident agent after an authorized request is accepted, independently
of the initiating chat session. Do not add duplicate permission switches,
new shadow owners or unnecessary per-operation login screens.

### Verification still required

- Prove outbound city identity and an authorized tool invocation end-to-end.
- Prove refresh/rotation, expiry, revocation and audit without leaking tokens.
- Prove inbound callback, correlation, durable readback and failure recovery.
- Prove Observatory mobile pairing separately; a readable station is not a
  paired mobile browser, and read-only observation is not browser control.
