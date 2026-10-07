import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler, createTestAuthorizationCode, createTestRefreshToken, verifyAccessToken } from '../src/mcp-oauth.mjs';
const issuer = 'https://city.example';
const verifier = 'v'.repeat(64);
const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');
function config() {
  const consumed = new Set(), failures = new Map();
  return { issuer, resource: issuer + '/mcp', signingKey: 'test-only-key', ownerPasscode: 'test-only-owner', clientId: 'go', clientSecret: 'test-only-secret', redirectUri: 'https://client.example/callback', subject: 'GO', scope: 'metropolis-go', now: () => 1000,
    ledger: { async consume(key) { if (consumed.has(key)) return false; consumed.add(key); return true; }, async blocked(key, now) { return (failures.get(key) || []).filter(t => now - t < 900).length >= 5; }, async failure(key, now) { failures.set(key, [...(failures.get(key) || []), now]); } } };
}
function token(form) { return new Request(issuer + '/oauth/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa('go:test-only-secret'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }); }
test('authorization code cannot be replayed after successful exchange', async () => {
  const cfg = config(), handler = createOAuthHandler(cfg);
  const code = await createTestAuthorizationCode({ ...cfg, codeChallenge: challenge });
  const form = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: cfg.redirectUri, resource: cfg.resource };
  const first = await handler(token(form));
  assert.equal(first.status, 200);
  const tokens = await first.json();
  assert.deepEqual(await verifyAccessToken(new Request(cfg.resource, { headers: { authorization: 'Bearer ' + tokens.access_token } }), cfg), { subject: 'GO', scope: 'metropolis-go' });
  assert.equal((await handler(token(form))).status, 400);
});
test('refresh token is single-use and replacement remains usable', async () => {
  const cfg = config(), handler = createOAuthHandler(cfg);
  const refresh = await createTestRefreshToken(cfg);
  const form = { grant_type: 'refresh_token', refresh_token: refresh, resource: cfg.resource };
  const first = await handler(token(form));
  assert.equal(first.status, 200);
  const rotated = (await first.json()).refresh_token;
  assert.notEqual(rotated, refresh);
  assert.equal((await handler(token(form))).status, 400);
  assert.equal((await handler(token({ ...form, refresh_token: rotated }))).status, 200);
});
test('owner passcode attempts are rate limited across new requests', async () => {
  const cfg = config(), handler = createOAuthHandler(cfg);
  function attempt() { return new Request(issuer + '/oauth/authorize', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '192.0.2.1' }, body: new URLSearchParams({ response_type: 'code', client_id: cfg.clientId, redirect_uri: cfg.redirectUri, code_challenge: challenge, code_challenge_method: 'S256', resource: cfg.resource, passcode: 'wrong' }) }); }
  for (let i = 0; i < 5; i++) assert.equal((await handler(attempt())).status, 403);
  assert.equal((await handler(attempt())).status, 429);
});
test('OAuth cannot issue grants without persistent replay protection', async () => {
  const cfg = config(); delete cfg.ledger;
  assert.equal((await createOAuthHandler(cfg)(token({ grant_type: 'refresh_token' }))).status, 503);
});
test('authorization server discovery also works at the MCP path-scoped well-known URL', async () => {
  const cfg = config();
  const handler = createOAuthHandler(cfg);
  const root = await handler(new Request(issuer + '/.well-known/oauth-authorization-server'));
  const scoped = await handler(new Request(issuer + '/.well-known/oauth-authorization-server/mcp'));
  assert.equal(root.status, 200);
  assert.equal(scoped.status, 200);
  assert.deepEqual(await scoped.json(), await root.json());
});

test('resource discovery exposes shared Metropolis scopes', async () => {
  const cfg = config();
  const response = await createOAuthHandler(cfg)(new Request(issuer + '/.well-known/oauth-protected-resource/mcp'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).scopes_supported, ['metropolis-go']);
});

test('authorize returns a safe invalid-client code without exposing request values', async () => {
  const cfg = config(), handler = createOAuthHandler(cfg);
  const response = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: 'unknown-client',
    redirect_uri: cfg.redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
    scope: 'metropolis-go',
  })));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.deepEqual(body, { code: 'OAUTH_INVALID_CLIENT' });
  assert.equal(JSON.stringify(body).includes('unknown-client'), false);
});

test('known ChatGPT CIMD client works even when remote metadata fetch is unavailable', async () => {
  const cfg = {
    ...config(),
    allowCimd: true,
    fetchImpl: async () => { throw new Error('network unavailable'); },
  };
  const handler = createOAuthHandler(cfg);
  const clientId = 'https://chatgpt.com/oauth/client.json';
  const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
  const response = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
    scope: 'metropolis-go',
    state: 'test',
  })));
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Metropolis authorization/);
  assert.match(html, /name="passcode"/);
  assert.match(html, /value="https:\/\/chatgpt\.com\/oauth\/client\.json"/);
});

test('Observatory native CIMD is pinned to GO and exposes an HTTPS callback', async () => {
  const cfg = { ...config(), allowCimd: true };
  const handler = createOAuthHandler(cfg);
  const clientId = `${issuer}/oauth/observatory-client.json`;
  const redirectUri = `${issuer}/oauth/observatory-callback`;
  const metadata = await handler(new Request(clientId));
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    client_id: clientId,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'metropolis-go',
  });

  const authorize = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
    scope: 'metropolis-go',
    state: 'native-state',
  })));
  assert.equal(authorize.status, 200);
  assert.match(await authorize.text(), /Enter as <strong>GO<\/strong>/);

  const consent = await handler(new Request(issuer + '/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: cfg.resource,
      scope: 'metropolis-go',
      state: 'native-state',
      passcode: cfg.ownerPasscode,
    }),
  }));
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'native-state');

  const exchange = await handler(new Request(issuer + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code: callback.searchParams.get('code'),
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: cfg.resource,
    }),
  }));
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.deepEqual(await verifyAccessToken(new Request(cfg.resource, {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  }), { ...cfg, clientId: null, acceptedClientIds: [clientId] }), { subject: 'GO', scope: 'metropolis-go' });
});
