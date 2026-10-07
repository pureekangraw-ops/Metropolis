# Observatory station / rail / durable Post Office v1

Implemented inside the existing Metropolis Worker, `MetropolisEntry` Durable Object,
`METROPOLIS_ENTRY` binding, serialized object gate, existing OAuth GO/LIGHT identities,
and existing owner passcode. This does not execute Android commands on the server.

## Native owner pairing

`POST /observatory/pair`, JSON:

```json
{"deviceId":"UUID","passcode":"native owner input","actor":"GO","authorities":["browser.observe","browser.reload","map.observe","map.focus"]}
```

Only the existing `MCP_OWNER_PASSCODE` authorizes pairing. Actor is exactly GO or
LIGHT. Authorities must be unique exact whitelist entries, never wildcards.
Five invalid owner passcodes in fifteen minutes block further pairing for the
remaining window. Attempts are persisted and bounded. Device registry caps at 100.

Browser scopes: `browser.observe`, `browser.navigate`, `browser.open`,
`browser.select`, `browser.close`, `browser.back`, `browser.forward`,
`browser.reload`, `browser.scroll`, `browser.click`, `browser.fill`.
Map scopes: `map.observe`, `map.upsert_zone`, `map.upsert_grid`, `map.upsert_pin`,
`map.note`, `map.recommend`, `map.highlight`, `map.focus`, `map.remove`, `map.clear`.
ROUTE is unavailable. No grant exists until explicit owner pairing.

Pairing calls actual city-runtime intake: a server UUID Work, ownerSystem
OBSERVATORY, requestedBy BIG, actual persisted checkpoint. Re-pairing reuses a
current owner/checkpoint-valid Work, rotates a 32-byte random device token and
clears both mailboxes. Only SHA-256 token hash is persisted. Work owner/checkpoint
changes invalidate device access and dynamic OAuth grants.

Response:

```json
{"token":"opaque native credential","browser":{"publishSnapshots":"HTTPS","pollCommands":"HTTPS","publishReceipts":"HTTPS","stopSharing":"HTTPS","disconnect":"HTTPS","deviceId":"UUID","workId":"actual Work UUID","checkpointId":"actual checkpoint","actor":"GO","authorities":["browser.observe","browser.reload"]},"map":{"publishSnapshots":"HTTPS","pollCommands":"HTTPS","publishReceipts":"HTTPS","stopSharing":"HTTPS","disconnect":"HTTPS","deviceId":"UUID","workId":"same Work UUID","checkpointId":"same checkpoint","actor":"GO","authorities":["map.observe","map.focus"]}}
```

URLs derive exclusively from `MCP_PUBLIC_ORIGIN`. Native credentials use
`Authorization: Bearer <device token>`, scoped to that device, for these routes:

| Operation | Browser | Map |
| --- | --- | --- |
| POST snapshot | `/observatory/device/:id/snapshots` | `/observatory/device/:id/map/snapshots` |
| GET pending commands | `/observatory/device/:id/commands` | `/observatory/device/:id/map/commands` |
| POST receipt | `/observatory/device/:id/receipts` | `/observatory/device/:id/map/receipts` |

`POST /observatory/device/:id/stop` JSON `{view:"browser"|"map",epoch:integer}`
clears that view snapshot/commands and persists an epoch floor at least previous
snapshot epoch plus one. Older snapshots cannot restore revoked capability.
Credentials and the other view survive. `POST /observatory/device/:id/disconnect`
revokes the device token, clears both views, and removes dynamic grants.

## Snapshot and command schemas

Browser snapshots use existing Android `HttpRelayClient` schema
`observer.snapshot.v1`, with deviceId, tabId, captureId, revision, sequence,
epoch, capturedAtEpochMs, appVersion, url, title, text, targets, truncated.
Work/checkpoint binding derives from the authenticated device session.

Map root fields are exactly schema `observatory.map.snapshot.v1`, deviceId,
captureId, revision, epoch, sequence, capturedAtEpochMs, workId, checkpointId,
state `{zones:[],grids:[],pins:[],notes:[]}`, foreground, interactive.
Geometry and feature entries use native MapCommandCodec representations.

Both views store one current snapshot. Integers must be safe nonnegative
integers. New captures must advance sequence within the same epoch; epochs
cannot decrease. Same captureId duplicate content is idempotent; changed content
is denied. Capture freshness is 30 seconds, with at most 5 seconds future clock
skew. Text is capped at 32 KiB, total snapshot/receipt JSON at 48 KiB, browser
targets at 300. Credential-named structured fields are rejected recursively;
observation text redacts common credential assignments/Bearer tokens and URL
userinfo, query and fragment. Arbitrary text still requires native privacy
filtering; this server is not a universal secret classifier. Secrets are never
logged.

Browser command uses existing native envelope:
commandId, actor, workId, checkpointId, tabId, deviceId, captureId, revision,
epoch, issuedAtEpochMs, expiresAtEpochMs, authority, action, parameters.
Actions exactly match native BrowserAction. Parameters are string values.

Map command envelope uses commandId, actor, workId, checkpointId, deviceId,
captureId, revision, epoch, issuedAtEpochMs, expiresAtEpochMs, authority,
command. Nested `command` is native MapCommandCodec JSON and must have matching
commandId and expectedRevision. Map commands require current snapshot foreground
and interactive true. Native executors remain responsible for guard checks,
geometry validation, rendering confirmation and actual execution.

All commands must match current capture/revision/epoch/device and current Work,
checkpoint and selected OAuth actor. Authority must equal view plus lowercase
native action and be explicitly paired. Current capture must be fresh. TTL is
positive, at most 30 seconds and unexpired; issue time cannot be over 5 seconds
in the future. Commands are capped at 8 KiB and 100 retained entries per view.
When full, terminal/expired entries may be evicted; otherwise acceptance fails.
Duplicate command IDs with identical retained content return unchanged acceptance;
changed retained content fails. Deduplication does not extend beyond bounded
retention. Queues survive fresh gateway instances and repeat polling until
validated terminal receipt or expiry.

Snapshot ACK: `{id:captureId,sequence,acceptedAtEpochMs}`.
Receipt ACK: `{id:commandId,sequence:0,acceptedAtEpochMs}`.
ACK means durable transport acceptance; it does not mean business success.

## Receipts and verified correlation

Receipt fields are exactly commandId, status, reason, beforeCaptureId,
afterCaptureId, executedAtEpochMs, readback (nullable string), businessOutcome
(exactly UNKNOWN). Browser statuses ACCEPTED, EXECUTED, REJECTED, UNKNOWN;
map statuses PENDING, APPLIED, REJECTED, CONFLICT, FAILED, UNKNOWN.

Map PENDING is intermediate and do not remove a live command from polling.
Browser ACCEPTED is a terminal callback/after-capture receipt. One map PENDING transition to a terminal receipt is allowed with unchanged beforeCaptureId.
Identical retained receipts are idempotent; changed terminal receipts fail.
ACCEPTED/EXECUTED/APPLIED requires beforeCaptureId equal commanded capture and execution
start timestamp within command lifetime. Readback string may contain serialized
native map receipt revision/features/renderToken. Receipt publication occurs
only after native capture/render evidence; publish after-snapshot before receipt.

Readback returns the exact retained receipt. Its afterSnapshotVerified flag is
true only for ACCEPTED/EXECUTED/APPLIED terminal receipts whose afterCaptureId equals the
current snapshot capture, matching command epoch, revision at least command
revision, snapshot capturedAt at/after executedAt, and fresh capture. All
businessOutcome results remain UNKNOWN and ownerExecutionVerified remains false.

## Existing MCP tools

The existing three tools remain unchanged. OAuth-selected actor must match native
owner pairing. `metropolis_arrive` refreshes actual Work/checkpoint pointers and
dynamic exact read and handoff grants. `metropolis_work` supports:

```json
{"action":"handoff","workId":"actual Work UUID","payload":{"stationId":"OBSERVATORY_STATION","operation":"observe","payload":{"deviceId":"UUID","view":"browser"}}}
```

Operations are observe, command (payload adds command envelope), readback
(payload adds commandId). The tool returns stationResult alongside durable Work
record/readback. Work handoff records store bounded correlation pointers, never
full page text or commands; Observatory Work history caps at 100 events. Existing
Work operations still verify persisted readback. The station never equates
mailbox acceptance or native receipt with verified business success.

System map and station plan include OBSERVATORY_STATION, OBSERVATORY destination
and RAIL_OBSERVATORY, using the existing durable runtime binding. No new OAuth
client, passcode, environment wildcard grant, Worker or backend is introduced.

## Durable storage and real Post Office delivery

Storage version 2 separates device authentication metadata, view mailbox indexes,
current snapshot payload, each command payload, each native receipt payload,
each entry's correlation metadata, and each DATA_CARGO envelope into separate
keys. No device/session value embeds all commands or receipts. Every value is
checked below 64 KiB, safely below the SQLite Durable Object 2 MiB value limit.
Each view retains at most 100 entries and 8 MiB of command/receipt JSON. Entries
older than 24 hours are dropped on load and removed on the next mailbox save;
every save removes evicted command, receipt, entry and cargo keys. Current
snapshot/cargo use fixed keys. Stop/disconnect/re-pair remove previous payloads.
Save operations use the existing durable storage transaction, and cargo failure
rolls back incomplete payload/index updates. Legacy aggregate sessions fail
closed until explicit owner re-pair.

Each browser/map view has persisted inbox/outbox MAILBOX records from the existing
`createMailbox` contract, with OPEN/CLOSED state and monotonic cargo sequence.
Snapshot, command and receipt publication persist the payload first, then use the
existing `createCargoEnvelope` and `deliverCargo` functions to create actual
DATA_CARGO and DELIVERY_RECEIPT identities. `payloadRef` is the real durable key
for that payload. Receiver is the selected OAuth actor for snapshot/native
receipt inbox delivery and `OBSERVATORY_DEVICE:<UUID>` for command outbox delivery.
Persisted rail uses the existing `createRailLink` contract between
METROPOLIS_STATION/METROPOLIS and OBSERVATORY_STATION/OBSERVATORY, rail ID
RAIL_OBSERVATORY, owner-paired device trust boundary. Each cargo records the
actual station, rail, view, device, Work and checkpoint route.

Post Office DELIVERED means delivery into the durable mailbox after payload
persistence. It does **not** assert Android polling, execution or owner/business
success. `deliveryBoundary` is DURABLE_MAILBOX and ownerExecutionVerified is
false. Station results expose the actual cargo/delivery receipt records under
postOffice, preserving queue acceptance versus native receipt versus after-capture
verification as separate evidence.

After-snapshot verification additionally requires afterCaptureId distinct from
commanded captureId and current snapshot sequence strictly greater than the
capture sequence persisted when the command was accepted. Equal timestamps are
allowed only with this distinct, strictly subsequent capture evidence.

Command polling returns at most 16 envelopes and at most 60 KiB of encoded JSON
per response, within the native 64 KiB transport ceiling. All 100 queued entries
remain durable; terminal ACKs let subsequent polls advance through the backlog.
A valid 8 KiB command cannot be starved by the byte ceiling.

Authentication and grants read only device metadata first. Invalid bearer tokens
never read command, receipt or snapshot payloads. Grant discovery filters the
owner-selected actor before reading actual Work context; it never hydrates view
mailboxes. Correct actor/device/context/scope checks precede hydration of the
single view required by the operation. Saving or stopping one view preserves the
other view without reading its payloads.
