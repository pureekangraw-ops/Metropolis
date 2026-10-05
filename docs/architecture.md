# Metropolis Architecture Contract

**Status:** foundation contract  
**Scope:** connection environment and City Hall boundaries  
**Contract:** `0.1.0`

## One sentence

**Metropolis connects independent operational systems into one environment. City Hall manages work intake, return, records and data without owning another system's live operation.**

## Topology

```text
METROPOLIS
├── CITY HALL
├── FACTORY
├── PRISM / APP
└── RAIL NETWORK
```

City Hall is one system inside Metropolis. Hall failure does not imply Factory or PRISM failure. Factory failure does not imply Hall failure. A Metropolis or entry failure can affect travel across the network while each operational system continues its own local operation.

## City Hall loop

```text
CITY HALL
  ↓
HERMES       intake / registration / index
  ↓
WORK SYSTEM  work identity / lifecycle / checkpoint / handoff
  ↓
STATION      one connection boundary for one Rail and its credential
  ↓
RAIL         one destination-specific connection bound to one Station
  ↓
OATH         transport / receipt / readback
  ↓
OWNER SYSTEM operation in its own domain
  ↓
RAIL / OATH  result and evidence return
  ↓
MIMIR        return / organization / index / update
  ↓
CITY HALL
```

Work System, Station, Rail, OATH and Data Management are system components, not Agents. HERMES and MIMIR are Hall employees. GO and LIGHT are Agents that travel through Metropolis; they are not Hall employees and Hall is not a mandatory chokepoint.

## Truth boundaries

- Each Owner System owns operational truth for its own domain.
- Work System owns work identity, lifecycle and continuity; it does not copy operational state.
- Current state is obtained from the Owner System through live readback.
- Historical state is represented by Records, Evidence and Lineage.
- There is no Central Board that mirrors current state from every system.
- Data Management stores durable information and can report `MATCH`, `DRIFT`, `CONFLICT` or `UNKNOWN`; it does not choose a winner or silently repair an Owner System.

## Connection vocabulary

- **Station:** one connection boundary owning exactly one Rail and its credential reference.
- **Rail:** one destination-specific connection bound to exactly one Station.
- **OATH:** the transport envelope moving over the Station/Rail pair; it does not select truth or authority.
- **Owner System:** the system that performs and reports its own operation.

Credential values belong to the Station boundary. Rails and OATH carry references and transport metadata, never raw credentials.

## Implementation guardrails

1. Keep City Hall and Owner Systems deployable independently.
2. Enforce `1 Station = 1 Rail` and `1 Rail = 1 Station`.
3. Keep the credential boundary at Station; do not duplicate it on Rail.
4. Keep Work identity separate from Owner operational state.
5. Require live Owner readback before treating an operation as complete.
6. Treat reconciliation as observation and classification, not automatic conflict resolution.
7. Preserve `UNKNOWN` when the Owner or connection cannot be read.
8. Add a new route only through an explicit Station/Rail/OATH contract.
