# BIG owner delegation for Metropolis MCP

## Contract

The single-owner Metropolis server is operated by BIG. After the **owner passcode is verified**, newly minted OAuth tokens identify the **owner** in `sub` and the **acting agent** in signed `act`:

- `sub: BIG` (or configured server-side `MCP_OWNER_ID`)
- `act: GO` or `act: LIGHT`
- `scope: metropolis-go` or `metropolis-light`, respectively
- `client_id`, issuer, audience and token expiry are still verified.

`BIG` is a **Metropolis-local owner alias**, authenticated by its server-side owner passcode, **not an OpenAI account ID**. Never infer an OpenAI identity from a chat payload. The server must not trust client-supplied `owner` or `actingAgent` fields.

The OAuth owner identity represents delegated authorization for **Metropolis only**. It does not bypass existing WorkPass, Work grants, station owner policy or other action gates. The acting agent remains GO/LIGHT for Work authorization and historical runtime compatibility.

## Durable action evidence

New owner-delegated mutating MCP calls append immutable, uniquely keyed records to Metropolis Entry Durable Object storage:

- `delegation:audit:<eventId>:INTENT` before execution (failure stops execution).
- `delegation:audit:<eventId>:RESULT` after execution.

Records contain `owner`, `actingAgent`, tool, action, scope, Work ID / Draft ID when provided, status and timestamps, **not** passcodes, access tokens or request payloads. A missing post-execution audit causes `DELEGATION_AUDIT_RECONCILIATION_REQUIRED`; operators must inspect the event instead of retrying blindly.

Responses for delegated sessions expose `delegatedAccess`; mutating responses also include an `auditEventId`.

## Safe migration / rollback

1. Keep `MCP_REQUIRE_OWNER_DELEGATION` unset (or not `1`). Legacy GO/LIGHT-subject access and refresh tokens continue to work as actor-only sessions, without falsely claiming owner identity.
2. Deploy and confirm the current connector still reads its authorized Work with no schema regression.
3. Reauthorize the same ChatGPT Metropolis connection through the **BIG owner passcode**. Inspect `metropolis_identity` for `delegatedAccess.owner = BIG`, `actingAgent = GO`.
4. Smoke test `metropolis_reception` with a draft, verify INTENT/RESULT and cancel that draft. Check Work rights are unchanged.
5. **Only after every active client is reauthorized**, set `MCP_REQUIRE_OWNER_DELEGATION=1`. Legacy actor-only tokens then receive 401. This is an explicit owner-governed cutover, not part of the automatic deploy.

Do not change signing key during rollout. Do not use the owner passcode as an OpenAI user ID. For multi-user deployments a true provider-verified owner identity and account-scoped consent records are required before replacing the single-owner alias.
