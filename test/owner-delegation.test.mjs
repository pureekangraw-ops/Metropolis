import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler, createTestAccessToken, verifyAccessToken } from '../src/mcp-oauth.mjs';
import { createGateway } from '../src/mcp-worker.mjs';

const origin = 'https://city.example';
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'v'.repeat(64);
const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
const signingKey = 'test-only-signing';
const ownerPasscode = 'test-only-owner';

function storage({ rejectAudit = false } = {}) {
  const values = new Map();
  return {
    values,
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) {
      if (rejectAudit && String(key).startsWith('delegation:audit:')) throw new Error('audit unavailable');
      values.set(key, structuredClone(value));
    },
    async list({ prefix = '' } = {}) {
      return new Map([...values].filter(([key]) => key.startsWith(prefix)));
    },
    async transaction(fn) { return fn(this); },
  };
}
function config() {
  const consumed = new Set(), revoked = new Set();
  return {
    issuer: origin, resource: origin + '/mcp', signingKey, ownerPasscode,
    ownerId: 'BIG', allowCimd: true, clients: [],
    now: () => 1000,
    ledger: {
      async blocked() { return false; },
      async failure() {},
      async consume(key) {
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
      async refreshFamilyRevoked(id) { return revoked.has(id); },
      async revokeRefreshFamily(id) { revoked.add(id); },
    },
  };
}
async function delegatedOAuthTokens() {
  const cfg = config();
  const handler = createOAuthHandler(cfg);
  const params = {
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', resource: cfg.resource,
    scope: 'metropolis-go',
  };
  const page = await handler(new Request(origin + '/oauth/authorize?' + new URLSearchParams(params)));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Owner <strong>BIG<\/strong>/);
  const authorized = await handler(new Request(origin + '/oauth/authorize', {
    method: 'POST', body: new URLSearchParams({ ...params, passcode: ownerPasscode, actor: 'GO' }),
  }));
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get('location')).searchParams.get('code');
  const exchanged = await handler(new Request(origin + '/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: verifier, redirect_uri: redirectUri, resource: cfg.resource,
    }),
  }));
  assert.equal(exchanged.status, 200);
  return { cfg, handler, tokens: await exchanged.json() };
}
function tokenRequest(token) {
  return new Request(origin + '/mcp', { headers: { authorization: 'Bearer ' + token } });
}
test('BIG consents; ChatGPT receives owner-subject token with GO as signed acting agent, including refresh', async () => {
  const { cfg, handler, tokens } = await delegatedOAuthTokens();
  const expected = { subject: 'BIG', owner: 'BIG', actor: 'GO', scope: 'metropolis-go', delegated: true };
  assert.deepEqual(await verifyAccessToken(tokenRequest(tokens.access_token), { ...cfg, requireClientId: true }), expected);

  const refreshed = await handler(new Request(origin + '/oauth/token', {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId,
      refresh_token: tokens.refresh_token, resource: cfg.resource,
    }),
  }));
  assert.equal(refreshed.status, 200);
  const refreshedTokens = await refreshed.json();
  assert.deepEqual(await verifyAccessToken(tokenRequest(refreshedTokens.access_token), { ...cfg, requireClientId: true }), expected);
});

test('delegation rejects owner mismatch, actor/scope mismatch, and non-consented identity; legacy stays actor-only', async () => {
  const cfg = config();
  const base = {
    issuer: origin, resource: cfg.resource, signingKey, clientId,
    subject: 'BIG', actor: 'GO', scope: 'metropolis-go', now: cfg.now,
  };
  const verify = async token => verifyAccessToken(tokenRequest(token), { ...cfg, requireClientId: true });
  await assert.rejects(verify(await createTestAccessToken({ ...base, subject: 'SOMEONE_ELSE' })));
  await assert.rejects(verify(await createTestAccessToken({ ...base, scope: 'metropolis-light' })));
  await assert.rejects(verify(await createTestAccessToken({ ...base, actor: 'UNKNOWN' })));
  await assert.rejects(verify(await createTestAccessToken({ ...base, actor: null })));
  const legacy = await createTestAccessToken({ ...base, subject: 'GO', actor: null });
  assert.deepEqual(await verify(legacy), { subject: 'GO', scope: 'metropolis-go' });
});

const env = {
  MCP_PUBLIC_ORIGIN: origin, MCP_OAUTH_SIGNING_KEY: signingKey,
  MCP_OWNER_PASSCODE: ownerPasscode,
  MCP_OAUTH_CLIENTS: JSON.stringify([
    { clientId: 'go', clientSecret: 'test-secret', subject: 'GO', scope: 'metropolis-go', redirectUris: ['https://client.example/callback'] },
  ]),
  MCP_WORK_GRANTS: '[]',
};
async function gatewayCall(gateway, name, args, { owner = 'BIG', actor = 'GO', scope = 'metropolis-go' } = {}) {
  const token = await createTestAccessToken({
    issuer: origin, resource: origin + '/mcp', signingKey, clientId: 'go',
    subject: owner, actor, scope,
  });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  assert.equal(response.status, 200);
  const result = (await response.json()).result;
  return result;
}

test('gateway runs GO on behalf of BIG, records append-only intent/result, and keeps Work rights unchanged', async () => {
  const durable = storage();
  const gateway = createGateway({ env, storage: durable, sourceSha: 'a'.repeat(40) });
  const identity = await gatewayCall(gateway, 'metropolis_identity', {});
  assert.equal(identity.structuredContent.name, 'GO');
  assert.deepEqual(identity.structuredContent.delegatedAccess, { owner: 'BIG', actingAgent: 'GO', authority: 'OWNER_DELEGATED' });
  const intake = await gatewayCall(gateway, 'metropolis_reception', {
    action: 'input_information', payload: { information: { title: 'Delegated smoke test' }, ownerSystem: 'FACTORY' },
  });
  assert.equal(intake.isError, false);
  assert.equal(typeof intake.structuredContent.auditEventId, 'string');
  const eventId = intake.structuredContent.auditEventId;
  const intent = await durable.get('delegation:audit:' + eventId + ':INTENT');
  const result = await durable.get('delegation:audit:' + eventId + ':RESULT');
  assert.equal(intent.owner, 'BIG');
  assert.equal(intent.actingAgent, 'GO');
  assert.equal(intent.action, 'input_information');
  assert.equal(result.status, 'OK');
  const legacyToken = await createTestAccessToken({
    issuer: origin, resource: origin + '/mcp', signingKey, clientId: 'go',
    subject: 'GO', scope: 'metropolis-go',
  });
  const legacy = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST', headers: {
      authorization: 'Bearer ' + legacyToken, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'metropolis_identity', arguments: {} } }),
  }));
  const old = (await legacy.json()).result.structuredContent;
  assert.equal(old.name, 'GO');
  assert.equal(old.delegatedAccess, undefined);
});

test('delegated mutation fails closed if owner audit storage cannot write the INTENT', async () => {
  const gateway = createGateway({ env, storage: storage({ rejectAudit: true }), sourceSha: 'a'.repeat(40) });
  const result = await gatewayCall(gateway, 'metropolis_reception', {
    action: 'input_information', payload: { information: { title: 'Must not be saved' }, ownerSystem: 'FACTORY' },
  });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.reason, 'DELEGATION_AUDIT_REQUIRED');
});

test('owner-delegation cutover flag refuses old actor-only token without widening rights', async () => {
  const gateway = createGateway({
    env: { ...env, MCP_REQUIRE_OWNER_DELEGATION: '1' },
    storage: storage(), sourceSha: 'a'.repeat(40),
  });
  const fresh = await gatewayCall(gateway, 'metropolis_identity', {});
  assert.equal(fresh.isError, false);
  assert.equal(fresh.structuredContent.delegatedAccess.owner, 'BIG');
  const legacy = await createTestAccessToken({
    issuer: origin, resource: origin + '/mcp', signingKey, clientId: 'go',
    subject: 'GO', scope: 'metropolis-go',
  });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + legacy, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'metropolis_identity', arguments: {} } }),
  }));
  assert.equal(response.status, 401);
});
