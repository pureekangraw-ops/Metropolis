# Station Branch Model v1

**Status:** LOCKED — v1.0.0 after exact-head CI and golden-path acceptance pass.

A Branch is **Station Core + Branch Profile**.

```text
HERMES NEW / RESUME -> WORK ONLINE + timestamp
  -> Station MATCH / IN
  -> Branch preflight
  -> Rail / destination work
  -> same Station MATCH / OUT
  -> PIXIE diagnostic + data lifecycle
  -> GO reviews returned items; add updates only if needed
  -> MIMIR organizes
  -> MIMIR COMPLETE / CANCEL -> WORK OFFLINE
```

Work ID is continuity/correlation identity and Station-log context, not a second security gate. Work Pass remains authority; Owner readback remains operational truth.

Every Journey uses `STATION_JOURNEY_V1` with fixed fields for Work/Checkpoint/Journey, Station/destination/actor, IN/OUT timestamps, and baggage groups for payload/artifact/evidence/receipt refs. Missing baggage is `[]`; it is not rejected. Journey IDs are indexed by HERMES search so a lost Work ID can be recovered without guessing.

PIXIE is the canonical manager of transit data lifecycle (`CURRENT -> SUPERSEDED -> ARCHIVED`) and Station diagnostics. PIXIE may count, diff and report unknowns, but may not approve or rewrite source truth.

The Station owns the return prompt. MIMIR does not ask “any update?” again; it organizes the packet GO reviewed. Work CANCEL and COMPLETE belong to MIMIR and immediately remove Work from ONLINE.

Factory/DWARF is the first Branch Profile: Factory health is preflight and DWARF verify is return inspection. Future Drive, Notion, Mail, Observatory, Mirror, Greenhouse and other Branches copy Station Core and provide only their profile, adapter/Rail, credential boundary and destination acceptance checks.


## Lock rule

Station Branch Model v1 is locked. New Branches must reuse the Station Core contract and may vary only through Branch Profile, adapter/Rail, credential boundary, and destination-specific acceptance behavior. Changes to the locked core require evidence of a failing invariant or a new explicit architecture decision; convenience alone is not a reason to fork the core flow.
