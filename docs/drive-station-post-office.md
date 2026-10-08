# Drive Station — Central Post Office outgoing cargo

**Status:** Implementation is in a Draft PR. Production is **not connected** until the Metropolis Worker has its own Google credentials and a verified live send/readback.

## Responsibilities

- `POST_OFFICE` routes DATA / ARTIFACT / EVIDENCE cargo; does **not** carry agents or own Work truth.
- `PIXIE` organizes reports, evidence, and data circulation. It does not execute Factory machines.
- `DWARF` remains the Factory Main Runner. No GO HUB, replacement Gate, duplicate OAuth identity, or new Worker is added.
- `DRIVE_STATION` sends **only** `ARCHIVE_DATA` cargo on an existing, authenticated Work; it does not delete R2 objects.

## Required configuration (Metropolis Worker, not legacy GO HUB)

Cloudflare Worker `metropolis` already has `TABLET_STORAGE` R2 bound to bucket `factory`.

Set four existing-style environment bindings on **metropolis**:

| Name | Binding type | Meaning |
| --- | --- | --- |
| `GOOGLE_CLIENT_ID` | secret_text | OAuth client issued for Google Drive access |
| `GOOGLE_CLIENT_SECRET` | secret_text | Matching OAuth client secret |
| `GOOGLE_REFRESH_TOKEN` | secret_text | Owner-authorized refresh token that can create and read files in the chosen folder |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | secret_text | Destination archive folder ID (not the root of all Drive) |

No OAuth secret or refresh token goes into the repo, Work payload, station receipt, or response. A Google Drive connector linked only to ChatGPT is **not** automatically available inside Cloudflare. The legacy `go-hub` Worker has similarly named Google credentials, but those secret values cannot be read or safely auto-copied from its binding list; transfer them only by authorized owner-controlled secret provisioning.

Use a dedicated folder and Google OAuth consent with the minimum scopes/visibility that permit the intended create/list/read-back operations. Google may require that the folder be accessible to the OAuth client; do not infer this from ChatGPT Drive access.

**Do not deploy** this PR until both the owner configures these bindings and CI verifies the result. With missing credentials, `DRIVE_STATION_NOT_CONFIGURED` fails closed; Metropolis does not advertise a verified Drive connection.

## Ingress / cargo reference

Through existing `metropolis_work` (no new tool):

```json
{
  "action": "handoff",
  "workId": "WORK-...",
  "payload": {
    "stationId": "DRIVE_STATION",
    "operation": "ARCHIVE_DATA",
    "payload": {
      "payloadRef": "r2://factory/metropolis/tablets/WORK-.../WORK-...:CP-01/snapshot/tablet.json"
    }
  }
}
```

The `payloadRef` must be an existing R2 object inside the *same Work ID and Checkpoint* and under `metropolis/tablets/` or `metropolis/post-office/`. No arbitrary R2 key, filename path traversal, base64 upload, or foreign Work is accepted. A newly issued GO or LIGHT Work Pass authorizes the Drive Station inside **that Work only**. Historical Work Passes are not silently widened or migrated.

Current maximum file size: **8 MiB**. File contents are never included in MCP output; only safe source references, a Drive file reference, SHA-256 evidence, Work/Checkpoint, and receipt identifiers.

## Real verification (release acceptance)

1. Confirm `/health` on the deployed source SHA reports `driveStation: BOUND_UNVERIFIED`; this means configured, **not** live-proven.
2. Use an authorized active Work and existing R2 cargo ref for `ARCHIVE_DATA`.
3. Drive Station refreshes the Google OAuth access token, checks for an existing identical cargo by stable SHA-256 idempotency marker, then creates the binary file if absent.
4. **Fetch Drive file metadata and bytes back**, verify parent folder, Work ID, Checkpoint, source SHA, cargo marker, size and SHA-256.
5. Post Office only then writes an outbound delivery receipt into the existing Work and rotates its evidence through PIXIE. The original R2 object remains untouched.
6. Repeat the same archive: it must return the same Drive receipt without a second upload. Altered Drive bytes, missing owner permissions, stale R2, wrong Work/Checkpoint, or OAuth failures must not report success.

GitHub unit tests use a fake Google provider; **they do not establish real Drive availability**. Live acceptance requires deployed source SHA and Google-side provider readback.

## Owner safety

Existing deployed `metropolis` must not be overwritten or have production settings replaced by CI accidentally. Stage the changes in a Draft PR. No automatic merge, deploy, deletion, or secret migration.
