# Shared GO / LIGHT Metropolis entry

Requested result: a separate Metropolis MCP connection for GO and LIGHT, with one arrival station that reads the current version and schemas in both new and existing rooms. Keep the legacy connection until the new runtime and both actual clients pass acceptance. This continues the City Runtime from Metropolis PR #5; it does not alter the legacy Hub.

## Entry and refresh

- Both actors use the same `/mcp` URL with separate OAuth client identities.
- `metropolis_arrive` is the arrival/refresh station, not a new Gate or transport subsystem. It returns the current version, exact build SHA, observed time, schema hash, tool schemas, action schemas and actor-specific Work grants.
- `metropolis_work` is a stable entry to current City Hall operations: read, intake, handoff and return. It requires the schema hash, Work ID and Checkpoint ID. Intake accepts an explicitly supplied checkpoint; it does not silently replace an existing identity.
- Every call reads the current code/registry and grants; no session captures an old registry. Changed release, schema or actor grants changes the hash. A stale call returns `SCHEMA_REFRESH_REQUIRED` with the current arrival manifest before any Work effect.
- A City Hall handoff records continuity; it does not execute a Factory job. Return records agent evidence with owner execution still unverified. Neither operation claims Owner execution or grants merge/deploy authority.
- The server is stateless Streamable HTTP, JSON responses, MCP protocol versions 2025-03-26 / 2025-06-18 / 2025-11-25. GET `/mcp` returns 405; server-initiated SSE tool-list notifications are not advertised. Existing client rooms must be connected to this new MCP first. Client-side tool caching may still require a reconnect; a server cannot forcibly replace an application's cached tool registry. Stable entry tools let connected old rooms retrieve current action schemas without adding tool names.

## Independent authentication and storage

OAuth uses this Worker's own issuer, resource, signing key, owner passcode and two fixed clients. PKCE S256, exact redirect URI, audience, expiry, client/actor/scope binding, single-use authorization codes, rotated single-use refresh tokens and owner attempt limiting are enforced. No credential from the legacy Hub is accepted or copied.

`MetropolisEntry` is a SQLite Durable Object. Work records, used-token hashes and owner attempt counts survive gateway/Worker restarts. Whole entry operations are serialized so read/change/readback and token consumption cannot interleave. Scope comes from explicit owner-configured Work grants, never from an agent's payload. Empty grants permit arrival/refresh only.

## Cloudflare setup

Repository: `pureekangraw-ops/Metropolis`. Worker name: `metropolis`. Configuration: `wrangler.jsonc`. Deployment command: `npx wrangler@4 deploy`. Build writes the exact commit into `src/mcp-source-identity.mjs`; a missing build identity fails closed.

Owner-controlled settings required before activation:

| Setting | Type | Value |
| --- | --- | --- |
| `MCP_PUBLIC_ORIGIN` | variable | Exact HTTPS origin returned by Cloudflare after creating this Worker; no trailing slash |
| `MCP_OAUTH_SIGNING_KEY` | secret | New random signing secret, independent of legacy Hub |
| `MCP_OWNER_PASSCODE` | secret | Owner's new authorization passcode |
| `MCP_OAUTH_CLIENTS` | secret JSON | Two distinct clients for GO and LIGHT, each with its own client ID/secret and exact redirect URI observed from its client configuration |
| `MCP_WORK_GRANTS` | variable JSON | Explicit actor/action/Work grants; default `[]` |
| `MCP_ALLOWED_ORIGINS` | variable JSON | Observed browser client origins if needed; default `[]` |
| `METROPOLIS_ENTRY` | Durable Object binding | Created by the supplied Wrangler migration |

Client JSON shape (placeholders must be replaced by actual client configuration):

```json
[
  {"clientId":"GO_CLIENT_ID","clientSecret":"GO_CLIENT_SECRET","subject":"GO","scope":"metropolis-go","redirectUris":["GO_ACTUAL_HTTPS_REDIRECT_URI"]},
  {"clientId":"LIGHT_CLIENT_ID","clientSecret":"LIGHT_CLIENT_SECRET","subject":"LIGHT","scope":"metropolis-light","redirectUris":["LIGHT_ACTUAL_HTTPS_REDIRECT_URI"]}
]
```

Example exact Work grants (replace the identity with the actual existing Work):

```json
[
  {"actor":"GO","action":"read","workId":"EXISTING_WORK_ID"},
  {"actor":"LIGHT","action":"read","workId":"EXISTING_WORK_ID"}
]
```

Intake grants additionally require `ownerSystem`; handoff grants additionally require `stationId`, `railId` and `operation`. This entry does not import old Hub Work records automatically or resolve migration conflicts.

## Acceptance before closing the old connection

1. Deployment evidence and `/health` show the exact pushed source SHA and READY.
2. Configure GO and LIGHT to the same observed MCP URL; each completes OAuth using its own actual redirect URI and authenticates as the correct actor.
3. Both actual clients initialize, list tools and arrive; they see current source/version/schema.
4. A granted Work is read with its original checkpoint. Unauthorized actor/destination is denied.
5. After a release/grant update, an already-open room arrives and sees the new manifest; an old hash cannot mutate Work. Verify actual client cache behavior.
6. Restart/readback proves the durable Work survives. Only then may BIG close the old route.

Local tests and CI/bundle prove implementation properties only. Production deployment, OAuth in actual clients, old-room refresh and runtime Work readback remain UNKNOWN until those destination reads succeed.

OAuth source lineage: adapted from `prytaneion-workspace/go-hub-oauth.mjs`, blob `c59f770264a9117b97c78d5c7633aa90b3c45939`; independent credentials, replay protection and identity binding added here.
