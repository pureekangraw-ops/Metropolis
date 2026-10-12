// Server-side outbound OAuth for tool-to-tool calls.
// NOT Metropolis's own /oauth/token issuer, and NOT Factory's HMAC rail.
// Storage and provider registration belong to Metropolis; no tokens are
// included in Work payloads, receipts, reports, or returned metadata.

const KEY_PREFIX = 'outbound:oauth:';
const ACTOR = /^[A-Z][A-Z0-9_-]{0,63}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const skewMs = 60_000;

export class OutboundCredentialError extends Error {
  constructor(code) { super(code); this.name = 'OutboundCredentialError'; this.code = code; }
}
function fail(code) { throw new OutboundCredentialError(code); }
function required(value, code, pattern = NAME) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(code);
  return value;
}
function secretBytes(base64) {
  let bytes;
  try { bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0)); } catch { fail('OUTBOUND_ENCRYPTION_KEY_INVALID'); }
  if (bytes.length !== 32) fail('OUTBOUND_ENCRYPTION_KEY_INVALID');
  return bytes;
}
function bytesToBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}
async function cipherKey(base64) {
  return crypto.subtle.importKey('raw', secretBytes(base64), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(key, payload, associatedData) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(associatedData) },
    key, new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { version: 1, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) };
}
async function unseal(key, sealed, associatedData) {
  try {
    const iv = Uint8Array.from(atob(sealed.iv), c => c.charCodeAt(0));
    const encrypted = Uint8Array.from(atob(sealed.ciphertext), c => c.charCodeAt(0));
    const data = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(associatedData) },
      key, encrypted,
    );
    return JSON.parse(new TextDecoder().decode(data));
  } catch { fail('OUTBOUND_CREDENTIAL_DECRYPT_FAILED'); }
}
function validateProvider(id, provider) {
  required(id, 'OUTBOUND_PROVIDER_ID_INVALID');
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) fail('OUTBOUND_PROVIDER_NOT_CONFIGURED');
  required(provider.stationId, 'OUTBOUND_STATION_REQUIRED');
  const url = new URL(provider.tokenEndpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('OUTBOUND_TOKEN_ENDPOINT_INVALID');
  if (!provider.clientId || !provider.clientSecret) fail('OUTBOUND_CLIENT_CREDENTIALS_REQUIRED');
  if (!['client_secret_basic', 'client_secret_post'].includes(provider.authMethod || 'client_secret_basic')) fail('OUTBOUND_CLIENT_AUTH_UNSUPPORTED');
  return { ...provider, tokenEndpoint: url.toString() };
}
function tokenState(tokens, now) {
  if (typeof tokens?.accessToken !== 'string' || !tokens.accessToken ||
      typeof tokens?.refreshToken !== 'string' || !tokens.refreshToken ||
      !Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= now) {
    fail('OUTBOUND_TOKEN_RESPONSE_INVALID');
  }
  return {
    accessToken: tokens.accessToken, refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt, scope: tokens.scope || null,
  };
}
function publicResult(providerId, stationId, state) {
  return {
    providerId, stationId,
    status: state?.status || 'NOT_CONNECTED',
    expiresAt: state?.expiresAt || null,
    lastOutcome: state?.lastOutcome || null,
  };
}

// The injected authorizer MUST validate authenticated actor, Work/Checkpoint,
// target Station and operation before any secret can be retrieved.
export function createOutboundToolTokenManager({
  store, encryptionKey, providers = {}, authorize, audit = async () => {},
  fetchImpl = fetch, now = () => Date.now(),
} = {}) {
  if (!store?.transaction || !store?.get || typeof authorize !== 'function' ||
      typeof audit !== 'function') fail('OUTBOUND_GATE_NOT_CONFIGURED');
  const providerMap = new Map(Object.entries(providers).map(([id, config]) => [id, validateProvider(id, config)]));
  const keyPromise = cipherKey(encryptionKey);

  async function permission(context, requestedOperation) {
    const actor = required(context?.actor, 'OUTBOUND_ACTOR_REQUIRED', ACTOR);
    const workId = required(context?.workId, 'OUTBOUND_WORK_REQUIRED');
    const checkpointId = required(context?.checkpointId, 'OUTBOUND_CHECKPOINT_REQUIRED');
    const stationId = required(context?.stationId, 'OUTBOUND_STATION_REQUIRED');
    const operation = required(context?.operation, 'OUTBOUND_OPERATION_REQUIRED');
    const providerId = required(context?.providerId, 'OUTBOUND_PROVIDER_ID_INVALID');
    const provider = providerMap.get(providerId);
    if (!provider || provider.stationId !== stationId) fail('OUTBOUND_PROVIDER_STATION_MISMATCH');
    const decision = await authorize({ actor, workId, checkpointId, stationId, operation, providerId, purpose: requestedOperation });
    if (decision?.allowed !== true) fail('OUTBOUND_WORK_PERMISSION_DENIED');
    return { provider, actor, workId, checkpointId, stationId, operation, providerId };
  }

  async function record(context, outcome) {
    await audit({
      actor: context.actor, workId: context.workId, checkpointId: context.checkpointId,
      stationId: context.stationId, operation: context.operation, providerId: context.providerId,
      outcome, observedAt: new Date(now()).toISOString(),
    }); // No token or encryption material may appear in audit.
  }

  // Only callable from a trusted BIG-approved consent/provisioning routine.
  // No public HTTP route is added by this module.
  async function provision(context, tokens) {
    const auth = await permission(context, 'PROVISION');
    const value = tokenState(tokens, now());
    const sealed = await seal(await keyPromise, value, KEY_PREFIX + auth.providerId);
    await store.transaction(async tx => {
      await tx.put(KEY_PREFIX + auth.providerId, {
        status: 'CONNECTED', sealed, expiresAt: value.expiresAt,
        lastOutcome: 'CONSENT_PROVISIONED',
      });
    });
    await record(auth, 'CONSENT_PROVISIONED');
    return publicResult(auth.providerId, auth.stationId, { status: 'CONNECTED', expiresAt: value.expiresAt, lastOutcome: 'CONSENT_PROVISIONED' });
  }

  async function getAccessToken(context) {
    const auth = await permission(context, 'USE');
    const name = KEY_PREFIX + auth.providerId;
    const encryption = await keyPromise;
    const current = await store.get(name);
    if (!current || current.status !== 'CONNECTED') {
      await record(auth, current?.status || 'NOT_CONNECTED');
      fail(current?.status === 'REAUTH_REQUIRED' ? 'OUTBOUND_REAUTH_REQUIRED' : 'OUTBOUND_NOT_CONNECTED');
    }
    if (current.expiresAt > now() + skewMs && !current.lease) {
      const value = await unseal(encryption, current.sealed, name);
      await record(auth, 'TOKEN_REUSED');
      return value.accessToken;
    }

    const lease = crypto.randomUUID();
    const reserved = await store.transaction(async tx => {
      const state = await tx.get(name);
      if (!state || state.status !== 'CONNECTED') return 'REAUTH_REQUIRED';
      if (state.lease) {
        // After an uncertain token exchange do not replay the prior refresh
        // token: the remote provider may already have rotated it.
        if (state.lease.until <= now()) {
          await tx.put(name, { ...state, status: 'REAUTH_REQUIRED', lease: null, lastOutcome: 'REFRESH_OUTCOME_UNKNOWN' });
          return 'REAUTH_REQUIRED';
        }
        return 'REFRESH_IN_PROGRESS';
      }
      if (state.expiresAt > now() + skewMs) return 'REUSE';
      await tx.put(name, { ...state, lease: { id: lease, until: now() + 30_000 } });
      return 'RESERVED';
    });
    if (reserved === 'REUSE') {
      const state = await store.get(name);
      const value = await unseal(encryption, state.sealed, name);
      await record(auth, 'TOKEN_REUSED');
      return value.accessToken;
    }
    if (reserved !== 'RESERVED') {
      await record(auth, reserved);
      fail(reserved === 'REFRESH_IN_PROGRESS' ? 'OUTBOUND_REFRESH_IN_PROGRESS' : 'OUTBOUND_REAUTH_REQUIRED');
    }

    let result = null;
    try {
      const previous = await unseal(encryption, (await store.get(name)).sealed, name);
      const data = new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: previous.refreshToken,
      });
      const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      const method = auth.provider.authMethod || 'client_secret_basic';
      if (method === 'client_secret_basic') {
        headers.authorization = 'Basic ' + btoa(auth.provider.clientId + ':' + auth.provider.clientSecret);
      } else {
        data.set('client_id', auth.provider.clientId);
        data.set('client_secret', auth.provider.clientSecret);
      }
      const response = await fetchImpl(auth.provider.tokenEndpoint, {
        method: 'POST', headers, body: data, redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) fail('OUTBOUND_TOKEN_REFRESH_REJECTED');
      const body = await response.json();
      if (body?.token_type?.toLowerCase() !== 'bearer' ||
          !Number.isFinite(Number(body.expires_in)) ||
          Number(body.expires_in) <= 0) fail('OUTBOUND_TOKEN_RESPONSE_INVALID');
      if (previous.scope && body.scope && previous.scope !== body.scope) fail('OUTBOUND_TOKEN_SCOPE_CHANGED');
      result = tokenState({
        accessToken: body.access_token,
        refreshToken: body.refresh_token || previous.refreshToken,
        expiresAt: now() + Number(body.expires_in) * 1000,
        scope: body.scope || previous.scope,
      }, now());
      const encrypted = await seal(encryption, result, name);
      const saved = await store.transaction(async tx => {
        const state = await tx.get(name);
        if (state?.status !== 'CONNECTED' || state.lease?.id !== lease) return false;
        await tx.put(name, {
          status: 'CONNECTED', sealed: encrypted, expiresAt: result.expiresAt,
          lastOutcome: 'ROTATED', lease: null,
        });
        return true;
      });
      if (!saved) fail('OUTBOUND_TOKEN_LEASE_LOST');
      await record(auth, 'ROTATED');
      return result.accessToken;
    } catch (error) {
      await store.transaction(async tx => {
        const state = await tx.get(name);
        if (state?.lease?.id === lease) await tx.put(name, {
          ...state, status: 'REAUTH_REQUIRED', lease: null, lastOutcome: 'REFRESH_OUTCOME_UNKNOWN',
        });
      });
      await record(auth, 'REFRESH_FAILED');
      if (error instanceof OutboundCredentialError) throw error;
      fail('OUTBOUND_TOKEN_REFRESH_FAILED');
    }
  }

  async function status(context) {
    const auth = await permission(context, 'INSPECT');
    return publicResult(auth.providerId, auth.stationId, await store.get(KEY_PREFIX + auth.providerId));
  }

  return Object.freeze({ provision, getAccessToken, status });
}
