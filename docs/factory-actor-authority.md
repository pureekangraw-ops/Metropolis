# Metropolis ↔ Factory: actor-neutral operating authority

**Goal:** an authenticated actor can dispatch to Factory when City Hall verifies an exact Work action and destination grant. A route connection alone gives no permission.

## Existing path

1. BIG authorizes a Metropolis actor (GO/LIGHT remain built in; other actors require exact owner-managed registration in the **existing** `MCP_OAUTH_CLIENTS_JSON` / `MCP_OAUTH_CLIENTS` server config, with a distinct client ID, server-held secret, HTTPS callback, uppercase actor ID and `metropolis-<lowercase-actor>` scope). Merely claiming an actor name in an MCP request does not register or authorize it.
2. City Hall authenticates that actor, checks `Work/Checkpoint` and the `handoff` operation, and checks `FACTORY_STATION` as the authorized destination.
3. City Hall overrides caller-supplied `actingActor` and `cityAuthorization` in the outgoing payload. It stamps the actual actor, operation, active Work Pass, and if needed a scoped `CITY_AUTHORIZATION_V1` derived only from a server-side explicit Work grant.
4. Metropolis sends over the **existing shared-secret HMAC rail**. Factory verifies signed transport and required Work Pass; if the caller is not the pass holder, Factory requires City-attested authority for matching actor, Work, Checkpoint, pass reference, action, station and operation.
5. Factory records actual acting actor and authorization source in receipt/readback; Metropolis verifies identity, SHA, Work, Checkpoint, pass reference and evidence before reporting handoff verified.

## Scope

- No GO-only/Light-only hardcode in the Factory Work Pass verifier.
- No implied delegation, public access, creation of an alternative city permission system, or transfer of ownership to Factory.
- No OAuth refresh token on the Metropolis–Factory internal HMAC rail.
- The Metropolis OAuth issuer's refresh-token lifecycle is separate from outbound tool credentials. A future external tool may support its own OAuth/refresh process.
- `REQUESTED != ACCEPTED != BOUNDARY_VERIFIED != DOMAIN_DONE`. A Factory `LIVE_E2E_BOUNDARY_HANDOFF` test can pass without machines being ready.

## Proof requirements

- Same-holder GO, LIGHT and configured future actor Work Pass: accepted.
- Explicit grant for LIGHT on GO-owned Work: accepted with correct City attestation.
- No grant, wrong actor, wrong destination, wrong Work/Checkpoint, wrong operation, cancelled pass, untrusted signature: rejected before receipt.
- Factory receipt and readback bind the authenticated actor to Work/Checkpoint and preserve evidence; Metropolis verifies returned actor.
- Production smoke must be performed only after the compatible Factory is deployed, then Metropolis; green unit tests alone are not production proof.

## Additional actor enrollment

The existing OAuth issuer can onboard up to 32 individually named registered
actors; this does not create another authentication door. Required fields per
client are `clientId`, `clientSecret`, `subject`, `scope`, and
`redirectUris` (HTTPS). `subject` is a unique uppercase ID
(`[A-Z][A-Z0-9_-]{0,63}`); `scope` is the exact matching
`metropolis-<lowercase-subject>`. The registered client also needs BIG's
existing owner authorization to obtain owner-delegated tokens. Never put client
secrets in Git or Work/Receipt payloads.

Registration only permits **authentication** as that actor. An actor gets no
existing Work access unless City Hall issues its own Work Pass or an explicit
per-Work grant. All other actors must be denied and cannot impersonate GO/LIGHT.
Factory accepts this identity only via the same signed City rail. Live actor
enrollment and live device pairing are separate acceptance tests.
