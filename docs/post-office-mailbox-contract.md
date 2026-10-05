# Post Office + Mailbox Contract v1

**Status:** contract only / no runtime delivery binding

Post Office manages data cargo. It does not route people or grant travel authority.

## Cargo identity

Every cargo envelope carries:

- `dataId` — stable data identity
- `dataKind` — DATA, ARTIFACT, or EVIDENCE classification
- `payloadRef` — pointer to the payload
- `owner` — owner of the data or result
- `sender` — sending system or agent
- `receiver` — intended receiving agent or system
- `mailbox` — intended mailbox identity
- `receipt` — durable evidence of delivery, initially null

## Delivery states

- `UNRESOLVED` — mailbox is missing or has not been resolved
- `ROUTED` — mailbox and receiver match, but no delivery receipt exists yet
- `DELIVERED` — delivery receipt exists
- `MISROUTED` — mailbox identity or receiver does not match
- `UNDELIVERABLE` — mailbox exists but is closed or unavailable

The executable source is `src/post-office.mjs`. Runtime adapters must preserve the envelope identity and may not treat provider acceptance as delivery without a receipt.
