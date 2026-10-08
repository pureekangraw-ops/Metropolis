import { createCityRuntime } from './city-runtime.mjs';
import { createMetropolisMcp, json } from './shared-mcp.mjs';
import { createOAuthHandler, verifyAccessToken } from './mcp-oauth.mjs';
import { SOURCE_SHA } from './mcp-source-identity.mjs';
import { createFactoryStationRuntime } from './factory-station-runtime.mjs';
import { createTabletRuntime } from './tablet-runtime.mjs';
import { createObservatoryStation } from './observatory-station.mjs';
import { inspectWorkPass } from './work-pass.mjs';

export async function bufferRequest(request, { timeoutMs = 10000, maxBytes = 65536 } = {}) {
  if (!request.body) return request;
  const reader = request.body.getReader();
  let timer, failed = false;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('BODY_TIMEOUT')), timeoutMs); });
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('BODY_TOO_LARGE');
      chunks.push(value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new Request(request.url, { method: request.method, headers: request.headers, body: bytes, redirect: request.redirect });
  } catch (error) { failed = true; throw error; }
  finally { clearTimeout(timer); if (failed) reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function registeredClientsFrom(env = {}) {
  const sources = [env.MCP_OAUTH_CLIENTS_JSON, env.MCP_OAUTH_CLIENTS].filter(value => typeof value === 'string' && value.trim() !== '');
  for (const raw of sources) {
    let clients;
    try { clients = JSON.parse(raw); } catch { continue; }
    if (!Array.isArray(clients) || clients.length > 2) continue;
    if (clients.length === 0) return [];
    const uniqueSubjects = new Set(clients.map(c => c?.subject));
    const uniqueClientIds = new Set(clients.map(c => c?.clientId));
    const valid = uniqueSubjects.size === clients.length
      && uniqueClientIds.size === clients.length
      && clients.every(c => (
        ['GO', 'LIGHT'].includes(c?.subject)
        && c.scope === 'metropolis-' + c.subject.toLowerCase()
        && c.clientId
        && c.clientSecret
        && Array.isArray(c.redirectUris)
        && c.redirectUris.length > 0
        && c.redirectUris.every(u => typeof u === 'string' && u.startsWith('https://'))
      ));
    if (valid) return clients;
  }
  return [];
}

function configFor(env, storage) {
  const issuer = env.MCP_PUBLIC_ORIGIN;
  if (!issuer || new URL(issuer).origin !== issuer || !issuer.startsWith('https://')) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  const clients = registeredClientsFrom(env);
  if (!env.MCP_OAUTH_SIGNING_KEY || !env.MCP_OWNER_PASSCODE || !storage?.transaction) throw new Error('OAUTH_STORAGE_REQUIRED');
  const ledger = {
    async consume(key, expiresAt) {
      return storage.transaction(async tx => { const id = 'oauth:used:' + key; if (await tx.get(id)) return false; await tx.put(id, { expiresAt }); return true; });
    },
    async blocked(key, now) { return (await storage.get('oauth:attempt:' + key) || []).filter(t => now - t < 900).length >= 5; },
    async failure(key, now) { const id = 'oauth:attempt:' + key; const previous = await storage.get(id) || []; await storage.put(id, [...previous.filter(t => now - t < 900), now]); },
  };
  return { issuer, resource: issuer + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, ownerPasscode: env.MCP_OWNER_PASSCODE, ownerId: String(env.MCP_OWNER_ID || 'BIG').trim(), clients: clients.map(c => ({ ...c, resources: [issuer + '/mcp'] })), allowCimd: true, ledger };
}

export function createGateway({ env, storage, sourceSha = SOURCE_SHA } = {}) {
  let oauth, service, runtime, observatory, authenticateMcp, resourceMetadataUrl, grants, configured = false;
  try {
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_UNKNOWN');
    const cfg = configFor(env, storage);
    grants = JSON.parse(env.MCP_WORK_GRANTS || '[]');
    if (!Array.isArray(grants) || grants.some(g => !['GO', 'LIGHT'].includes(g.actor) || !['read', 'handoff', 'return', 'cancel', 'complete'].includes(g.action) || !g.workId || g.workId === '*')) throw new Error('EXPLICIT_WORK_GRANTS_REQUIRED');
    const factoryStation = createFactoryStationRuntime({
      baseUrl: env.FACTORY_RUNTIME_URL,
      sharedSecret: env.METROPOLIS_FACTORY_SHARED_SECRET,
    });
    const tabletRuntime = createTabletRuntime({
      bucket: env.TABLET_STORAGE,
      sourceSha,
    });
    runtime = createCityRuntime({
      sourceSha,
      store: {
        get: key => storage.get(key),
        async put(key, value) { await storage.put(key, value); return value; },
        async list(prefix = '') {
          const rows = await storage.list({ prefix });
          return [...rows.entries()].map(([key, value]) => ({ key, value }));
        },
      },
      stationRuntimes: { FACTORY_STATION: factoryStation },
      tabletRuntime,
    });
    observatory = createObservatoryStation({ env, storage, runtime });
    oauth = createOAuthHandler(cfg);
    resourceMetadataUrl = cfg.issuer + '/.well-known/oauth-protected-resource';
    authenticateMcp = async request => {
      const identity = await verifyAccessToken(request, { ...cfg, requireClientId: true, acceptedClientIds: cfg.clients.map(c => c.clientId) });
      return { actor: identity.actor || identity.subject, owner: identity.owner || null, scope: identity.scope, delegated: identity.delegated === true };
    };
    service = createMetropolisMcp({
      runtime,
      sourceSha,
      version: '1.0.0',
      grants,
      observatoryObserve: input => observatory.observe(input),
      allowedOrigins: [cfg.issuer, 'https://chatgpt.com', ...JSON.parse(env.MCP_ALLOWED_ORIGINS || '[]')],
      authenticate: authenticateMcp,
      appendDelegationAudit: async event => {
        if (!event?.eventId || !event?.stage || !event?.owner || !event?.actor) throw new Error('DELEGATION_AUDIT_INVALID');
        // Durable Object storage is serialized by MetropolisEntry and keys never overwrite.
        const key = 'delegation:audit:' + event.eventId + ':' + event.stage;
        if (await storage.get(key)) throw new Error('DELEGATION_AUDIT_DUPLICATE');
        await storage.put(key, { ...event, recordedAt: new Date().toISOString() });
      },
    });
    configured = true;
  } catch { /* Missing or invalid owner configuration fails closed. */ }
  return { async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ service: 'METROPOLIS_MCP', version: '1.0.0', sourceSha, status: configured ? 'READY' : 'NOT_CONFIGURED', persistentStorage: Boolean(storage), observedAt: new Date().toISOString(), ownerSystemsVerified: false }, configured ? 200 : 503);
    if (!configured) return json({ reason: 'METROPOLIS_MCP_NOT_CONFIGURED' }, 503);
    if (url.origin !== env.MCP_PUBLIC_ORIGIN) return json({ reason: 'ORIGIN_MISMATCH' }, 403);
    if (url.pathname === '/observatory/pair') {
      if (request.method !== 'POST') return json({ reason: 'METHOD_NOT_ALLOWED' }, 405);
      let principal;
      try {
        principal = await authenticateMcp(request);
      } catch {
        return json(
          { reason: 'AUTH_REQUIRED' },
          401,
          { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` },
        );
      }
      if (principal.actor !== 'GO') return json({ reason: 'GO_REQUIRED' }, 403);
      if (!request.headers.get('content-type')?.startsWith('application/json')) {
        return json({ reason: 'CONTENT_TYPE_REQUIRED' }, 415);
      }
      let body;
      try {
        const raw = await request.text();
        if (new TextEncoder().encode(raw).length > 2048) return json({ reason: 'PAYLOAD_TOO_LARGE' }, 413);
        body = JSON.parse(raw);
      } catch {
        return json({ reason: 'INVALID_ARGUMENT' }, 400);
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || typeof body.workId !== 'string' || !body.workId.trim()) {
        return json({ reason: 'INVALID_ARGUMENT' }, 400);
      }
      const workId = body.workId.trim();
      const work = await runtime.getWork(workId);
      if (!work) return json({ reason: 'WORK_NOT_FOUND' }, 404);
      if (work.ownerSystem !== 'OBSERVATORY') return json({ reason: 'WORK_OWNER_MISMATCH' }, 403);
      const explicit = grants.filter(grant => grant.actor === principal.actor && grant.workId === workId);
      const actions = explicit.length > 0
        ? explicit.map(grant => grant.action)
        : inspectWorkPass(work.workPass, {
          actor: principal.actor,
          workId: work.workId,
          checkpointId: work.checkpointId,
          workState: work.state,
        }).actions;
      if (!actions.includes('read')) return json({ reason: 'NO_GRANT' }, 403);
      try {
        return json(await observatory.pair({ actor: principal.actor, workId }));
      } catch (error) {
        const reasons = new Set(['WORK_NOT_FOUND', 'WORK_OWNER_MISMATCH', 'CHECKPOINT_MISMATCH', 'WORK_CLOSED']);
        return json({ reason: reasons.has(error.message) ? error.message : 'OBSERVATORY_PAIR_FAILED' }, 400);
      }
    }
    if (url.pathname.startsWith('/observatory/device/')) return observatory.fetch(request);
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      // OAuth discovery and authorization endpoints are intentionally public.
      // Identity and authority are still enforced by PKCE, client validation,
      // owner authentication, token validation and server-side policy. Existing-Work operations may also use Work grants.
      return oauth(request);
    }
    if (url.pathname === '/mcp' && request.method === 'POST') {
      try {
        await authenticateMcp(request);
      } catch {
        return json(
          { reason: 'AUTH_REQUIRED' },
          401,
          { 'www-authenticate': `Bearer resource_metadata="${resourceMetadataUrl}"` },
        );
      }
    }
    return service.fetch(request);
  } };
}

export class MetropolisEntry {
  constructor(state, env) { this.state = state; this.env = env; }
  async fetch(request) {
    const buffered = await bufferRequest(request);
    // Serialize the complete operation: Work read/change/readback and OAuth token consumption.
    return this.state.blockConcurrencyWhile(async () => {
      try { return await createGateway({ env: this.env, storage: this.state.storage }).fetch(buffered); }
      catch { return json({ reason: 'ENTRY_OPERATION_FAILED' }, 500); }
    });
  }
}
export default {
  async fetch(request, env) {
    if (!env.METROPOLIS_ENTRY) return json({ reason: 'DURABLE_BINDING_REQUIRED' }, 503);
    // Read untrusted network streams at the edge, before they can hold the shared object gate.
    let buffered;
    try { buffered = await bufferRequest(request); }
    catch (error) { return json({ reason: error.message }, error.message === 'BODY_TIMEOUT' ? 408 : 413); }
    return env.METROPOLIS_ENTRY.get(env.METROPOLIS_ENTRY.idFromName('CITY_HALL_ENTRY')).fetch(buffered);
  },
};
