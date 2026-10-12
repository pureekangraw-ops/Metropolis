# HALL Technical Contract v1

**Status:** implemented on a feature branch for review; not merged or deployed.  
**Authority:** implements the three Owner Decisions ratified by BIG in the current work context.  
**Baseline:** `main` at `42cbeae398493dac6affbdf8672d38b5124c365a`.

## Boundaries retained

- HALL / Work System owns Work identity, scope, lifecycle, checkpoints, evidence references, decisions, and outcome.
- Owner Systems remain authoritative for their own domain execution and readback.
- Greenhouse owns durable dispatch and delivery attempts.
- Post Office carries data cargo and receipts; it is not an execution router.
- PIXIE manages report and lineage references; it does not approve work or replace owner evidence.
- GO and LIGHT remain peer agents. Role specialization does not create an authority hierarchy.
- Work Pass and existing authentication continue to enforce actor, Work, checkpoint, and action permissions. Commands and event names do not grant authority.

## Work completion contract

New HERMES Work creation requires `information.completionCriteria`:

```json
{
  "schema": "WORK_COMPLETION_CRITERIA_V1",
  "items": [
    {
      "criterionId": "result",
      "description": "The requested result is returned and verified",
      "independentReviewRequired": false
    }
  ]
}
```

Each item needs a unique stable ID and a human-readable acceptance condition. `independentReviewRequired` is optional and defaults to `false`. The criteria are stored on the Work record. A draft without valid criteria cannot pass HERMES review for `READY_TO_CREATE`.

MIMIR `complete` receives a `criteriaResults` array. Every Work criterion must have exactly one `PASS` result with at least one `evidenceRefs` entry. `FAIL`, `UNKNOWN`, missing results, or missing evidence are recorded as a completion check but do not change the lifecycle state. Unknown criterion IDs and duplicate results are rejected.

If a Work has a handoff, completion is blocked until the Work has a verified `RETURNED` result. An accepted completion check is the only route to `COMPLETED`; `TOOL_DONE` and a transport receipt are not substitutes.

For Work records created before this contract, missing criteria remain unknown; this implementation does not invent acceptance conditions. Such Work cannot be completed by the v1 gate until its criteria are supplied through an owner-approved migration or a new Work.

## Typed ToolSignal events

The top-level `ToolSignal` kinds remain `MESSAGE`, `EVENT`, and `ACK`. An `EVENT` body uses `schema: "TOOL_EVENT_V1"` and one of the ratified `eventType` values:

- `TOOL_DONE`: requires Work ID, checkpoint ID, and non-empty evidence references.
- `ERROR`: requires Work ID, checkpoint ID, and a reason.
- `APPROVAL_REQUIRED`: requires Work ID, checkpoint ID, and a reason; it does not imply approval.

Example:

```json
{
  "schema": "TOOL_EVENT_V1",
  "eventType": "TOOL_DONE",
  "evidenceRefs": ["test://result"],
  "checkpointRefs": {
    "safeCandidateRef": "checkpoint://candidate-1"
  }
}
```

No `COMPLETED` event is accepted from a Tool. Events are signals, not Work lifecycle truth.

`checkpointRefs.safeCandidateRef` and `checkpointRefs.errorCaptureRef` are references only. They do not establish safety, grant resume authority, or change lifecycle. A returned Work may retain references supplied by its owner readback; safe/resume decisions remain separate.

## Exception-based return review

A verified owner readback with evidence and no review trigger follows the normal path directly to MIMIR organization; GO review is not required on every return.

An independent review is required when:

- the acceptance criteria are missing/unclear or owner readback is not verified;
- a criterion explicitly requires independent review; or
- the owner readback reports one or more of `RECOVERY`, `ROLLBACK`, `SCOPE_CHANGE`, `CONFLICTING_EVIDENCE`, `REPEATED_FAILURE`, `SAFETY_SECURITY_IMPACT`, `ACCEPTANCE_UNCLEAR`, or `CONTRACT_REVIEW_REQUIRED`.

Only a different authenticated actor from the actor who submitted the return can complete that independent review. Review does not turn unverified owner reality into verified truth; the Work remains `UNKNOWN` and cannot pass completion while the return is unverified.

## Verification boundary

This contract is covered by local unit tests on the feature branch. Branch verification is not a production readback. Merge, deploy, and live lifecycle changes remain out of scope until separately authorized.