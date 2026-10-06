import { createCityRuntime } from './city-runtime.mjs';
import { createMetropolisMcp, json } from './shared-mcp.mjs';
import { createOAuthHandler, verifyAccessToken } from './mcp-oauth.mjs';
import { SOURCE_SHA } from './mcp-source-identity.mjs';

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

function configFor(env, storage) {
  const issuer = env.MCP_PUBLIC_ORIGIN;
  if (!issuer || new URL(issuer).origin !== issuer || !issuer.startsWith('https://')) throw new Error('PUBLIC_ORIGIN_REQUIRED');
  const clients = JSON.parse(env.MCP_OAUTH_CLIENTS || '[]');
  if (!Array.isArray(clients) || clients.length > 2 || new Set(clients.map(c => c.subject)).size !== clients.length || new Set(clients.map(c => c.clientId)).size !== clients.length || clients.some(c => !['GO', 'LIGHT'].includes(c.subject) || c.scope !== 'metropolis-' + c.subject.toLowerCase() || !c.clientId || !c.clientSecret || !Array.isArray(c.redirectUris) || !c.redirectUris.length || c.redirectUris.some(u => !u.startsWith('https://')))) throw new Error('REGISTERED_CLIENTS_REQUIRED');
  if (!env.MCP_OAUTH_SIGNING_KEY || !env.MCP_OWNER_PASSCODE || !storage?.transaction) throw new Error('OAUTH_STORAGE_REQUIRED');
  const ledger = {
    async consume(key, expiresAt) {
      return storage.transaction(async tx => { const id = 'oauth:used:' + key; if (await tx.get(id)) return false; await tx.put(id, { expiresAt }); return true; });
    },
    async blocked(key, now) { return (await storage.get('oauth:attempt:' + key) || []).filter(t => now - t < 900).length >= 5; },
    async failure(key, now) { const id = 'oauth:attempt:' + key; const previous = await storage.get(id) || []; await storage.put(id, [...previous.filter(t => now - t < 900), now]); },
  };
  return { issuer, resource: issuer + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, ownerPasscode: env.MCP_OWNER_PASSCODE, clients: clients.map(c => ({ ...c, resources: [issuer + '/mcp'] })), allowCimd: true, ledger };
}

export function createGateway({ env, storage, sourceSha = SOURCE_SHA } = {}) {
  let oauth, service, configured = false;
  try {
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('SOURCE_UNKNOWN');
    const cfg = configFor(env, storage);
    const grants = JSON.parse(env.MCP_WORK_GRANTS || '[]');
    if (!Array.isArray(grants) || grants.some(g => !['GO', 'LIGHT'].includes(g.actor) || !['read', 'intake', 'handoff', 'return'].includes(g.action) || !g.workId || g.workId === '*')) throw new Error('EXPLICIT_WORK_GRANTS_REQUIRED');
    const runtime = createCityRuntime({ sourceSha, store: { get: key => storage.get(key), async put(key, value) { await storage.put(key, value); return value; } } });
    oauth = createOAuthHandler(cfg);
    service = createMetropolisMcp({ runtime, sourceSha, version: '1.0.0', grants, allowedOrigins: [cfg.issuer, ...JSON.parse(env.MCP_ALLOWED_ORIGINS || '[]')], authenticate: async request => {
      const identity = await verifyAccessToken(request, { ...cfg, requireClientId: true, acceptedClientIds: cfg.clients.map(c => c.clientId) });
      return { actor: identity.subject };
    } });
    configured = true;
  } catch { /* Missing or invalid owner configuration fails closed. */ }
  return { async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ service: 'METROPOLIS_MCP', version: '1.0.0', sourceSha, status: configured ? 'READY' : 'NOT_CONFIGURED', persistentStorage: Boolean(storage), observedAt: new Date().toISOString(), ownerSystemsVerified: false }, configured ? 200 : 503);
    if (!configured) return json({ reason: 'METROPOLIS_MCP_NOT_CONFIGURED' }, 503);
    if (url.origin !== env.MCP_PUBLIC_ORIGIN) return json({ reason: 'ORIGIN_MISMATCH' }, 403);
    if (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/')) {
      // OAuth discovery and authorization endpoints are intentionally public.
      // Identity and authority are still enforced by PKCE, client validation,
      // owner authentication, token validation, scopes and Work grants.
      return oauth(request);
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
