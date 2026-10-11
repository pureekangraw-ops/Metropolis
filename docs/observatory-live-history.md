# Observatory live history

The paired foreground Android browser and native map publish on a five-second loop. Browser samples a freshly observed DOM (no older than five seconds); each history sample has an independent capture ID. No background browsing observation occurs. An explicit pause stops the current surface until it resumes.

Device snapshot, stop, and saved-range requests go from the Metro edge through the existing signed private Greenhouse transport into Hall. Forwarding happens before entering the serialized Hall Durable Object to avoid a self-call deadlock. Greenhouse does not persist ephemeral captures or device credentials in the Work queue.

Hall validates the paired device credential, schema, actor, epoch, monotonic sequence, and capture freshness. Tool pairing needs no new Work. Existing Work observation still checks the Work Pass, then resolves that actor's paired source. The Work/job stores only receipt metadata and an expiry pointer; it does not silently make a permanent content copy.

Each temporary capture becomes unavailable at age 15 seconds. Hall schedules idempotent Durable Object alarms for physical deletion, and reads also prune expired records. Stop prevents delayed writes from the old epoch and schedules transient state cleanup 30 seconds later. Missing close notifications use 30 seconds since the last accepted capture. Alarm execution can be delayed by the platform, but reads never expose expired content. Device credentials and anti-replay counters remain paired; owner-created map pins and tabs are separate from temporary observations.

`metropolis_observatory_memory` is actor-scoped, without mandatory Work creation:

- `history` with `view` reads the currently live range.
- `preserve` with `view` stores the whole current range; optional `captureIds` selects up to four captures and `label` labels it. Expired selections fail rather than save a partial range.
- `list` returns saved-range references.
- `read` with `savedId` retrieves the exact saved range, its timestamps, device/source provenance and evidence reference.

Saved captures have independent durable storage and survive temporary expiry, closing the app, and device disconnection. Only an explicit preserve operation retains content permanently. Android provides Keep this range, Saved ranges, and Copy for reuse. History consists of redacted browser/map observations, not bitmap screenshots. Remote browser or map command execution is outside this change.
