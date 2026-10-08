# Metropolis Drive Station

Status: Draft integration. CI tests use a mock Google API. Live production transfer is not verified.

## Route
GO/LIGHT → HERMES Work (owner GOOGLE_DRIVE) → DRIVE_STATION → POST OFFICE → R2 outbox → Google Drive API → file readback → postal receipt → MIMIR.

The code uses the existing Metropolis Worker and R2 binding, not legacy GO HUB requests. Work Pass authorizes DRIVE_STATION per Work and Checkpoint. Inline cargo is staged to R2 and removed from persisted Work. Readback must match provider file ID, folder, metadata, and SHA-256 before a receipt is issued.

## Deployment prerequisites
Configure Google OAuth client ID, client secret, refresh token, and an approved Google Drive destination folder ID on the existing Metropolis Worker. These settings are currently absent. The old GO HUB has corresponding secrets, but their values cannot be read from Cloudflare's settings listing.

Do not store credentials in code or Work messages. Do not assume the connected ChatGPT Drive app makes Metropolis authorized.

## Smoke test
Create a new HERMES Work with ownerSystem GOOGLE_DRIVE. Handoff to DRIVE_STATION with operation ARCHIVE_CARGO and payload dataKind=DATA, fileName=smoke.txt, mimeType=text/plain, content=YGG METRO smoke. Confirm the R2 source is staged, Drive file exists in the approved folder, file contents match R2 SHA-256, and Work POST OFFICE receipt says DELIVERED. The receipt is evidence of storage transfer only.

Do not merge or deploy without runtime secrets, CI checks, and live readback.
