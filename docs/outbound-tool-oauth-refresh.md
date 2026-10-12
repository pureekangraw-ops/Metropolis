# Outbound Tool-to-Tool OAuth Refresh (separate from inbound OAuth)

**Scope:** Metropolis operates as an OAuth **client of a destination tool**, not as the OAuth issuer for GO/LIGHT/registered actors. This corrects a critical scope distinction:

- `/oauth/token` serves **inbound** GO/LIGHT/other registered actors connecting *to* Metropolis.
- `createOutboundToolTokenManager` manages **outbound** credentials that BIG separately authorizes for Metropolis to call an OAuth-capable destination.
- **Metropolis ↔ Factory** uses signed HMAC requests and a server-side shared secret, **not** OAuth refresh. Do not introduce a second OAuth door to Factory or paste an access/refresh token into a Work.
- A destination without refresh support (e.g., short-lived service token from an app installation) needs that provider's supported renewal mechanism, not fabricated OAuth refresh.

## Contract

1. BIG grants or revokes destination-app access through the **provider's legitimate consent flow**; credentials must enter only through trusted server-side provisioning. This module intentionally exposes no unauthenticated setup endpoint.
2. City Hall authenticates the calling actor and checks its **Work ID, Checkpoint ID, Station, and operation** before an access token can be read. The module requires a server-provided `authorize` callback and refuses missing grants.
3. An allowlisted server-side provider profile has a fixed HTTPS token endpoint, a matching Station ID, client credentials (Worker secrets), and provider-specific scopes. **Never accept a token endpoint or client secret from Work payloads.**
4. The destination access/refresh tokens live **encrypted (AES-256-GCM, with provider-bound additional authenticated data)** in Durable Object storage. Only connection status and expiry may be inspected. Encryption keys and provider credentials live in Cloudflare secrets; neither belongs in git, logs, tool receipts, or durable Work envelopes.
5. Near expiry, renew only through `grant_type=refresh_token` using the provider's supported confidential-client authentication. Store the returned rotating refresh token before using the new access token.
6. A durable lease allows **one in-flight refresh per provider**. Any unconfirmed exchange or expired lease becomes `REAUTH_REQUIRED` to prevent accidental reuse of a consumed refresh token. The owner must reauthorize the destination; never silently fall back to expired or ChatGPT session credentials.
7. An audit hook records actor, Work/Checkpoint, destination, operation and **outcome only**; it cannot log token strings. A rotated token means credential maintenance worked, *not* that Factory or another tool completed the Work.
8. Refresh changes **credentials only**, never actor permissions, Work ownership, deployment authority, or accepted destination operations.

## Integration status

The module and tests provide a secure **server-side credential-management foundation**. They do **not** connect Notion, Drive, GitHub, Factory, Observatory, or any provider by themselves. A real destination requires: owner-approved provider profile/secret and consent tokens, a City Hall permission callback, and an outbound Station adapter consuming `getAccessToken` after authorization. Do not claim an external provider has auto-refresh until a live roundtrip succeeds.

### Integration skeleton

```js
const manager = createOutboundToolTokenManager({
  store: durableObjectStore,
  encryptionKey: env.OUTBOUND_TOKEN_ENCRYPTION_KEY,
  providers: providerProfilesFromServerOnly,
  authorize: cityHallAuthorizeScopedWorkAction,
  audit: appendRedactedAuditEvent,
});
// Trusted callback, never a public chat parameter:
// await manager.provision(authenticatedWorkContext, ownerConsentedTokens);
const token = await manager.getAccessToken(authenticatedWorkContext);
// Send token *only* in the authorized provider HTTPS request headers.
// Return receipts/readback without tokens.
```

**Acceptance:** positive rotation, denied actor, failed exchange, concurrent refresh, encryption/no secret in audit, then a live outbound provider call returning independently verified Receipt/Readback.
