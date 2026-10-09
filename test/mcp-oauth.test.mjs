import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler, createTestAccessToken, createTestAuthorizationCode, createTestRefreshToken, verifyAccessToken } from '../src/mcp-oauth.mjs';
const issuer = 'https://city.example';
const verifier = 'v'.repeat(64);
const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');

test('Notion CIMD authorizes LIGHT and exchanges and refreshes its tokens', async () => {
  const clientId = 'https://app.notion.com/oauth/mcp-client-metadata.json';
  const redirectUri = 'https://app.notion.com/workflows/mcp/oauth/callback';
  const cfg = { ...config(), allowCimd: true, fetchImpl: async url => {
    assert.equal(url, clientId);
    return Response.json({ client_id: clientId, redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none' });
  } };
  const handler = createOAuthHandler(cfg);
  const params = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', resource: cfg.resource,
    scope: 'metropolis-go metropolis-light', state: 'notion-test' };
  const page = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams(params)));
  assert.equal(page.status, 200);
  assert.match(await page.text(), /option value="LIGHT"/);
  const authorized = await handler(new Request(issuer + '/oauth/authorize', {
    method: 'POST', body: new URLSearchParams({ ...params, actor: 'LIGHT', passcode: cfg.ownerPasscode }) }));
  assert.equal(authorized.status, 302);
  const location = new URL(authorized.headers.get('location'));
  assert.equal(location.origin + location.pathname, redirectUri);
  assert.equal(location.searchParams.get('state'), 'notion-test');
  const exchange = await handler(new Request(issuer + '/oauth/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId,
      code: location.searchParams.get('code'), code_verifier: verifier,
      redirect_uri: redirectUri, resource: cfg.resource }) }));
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.equal(tokens.scope, 'metropolis-light');
  const identity = access => verifyAccessToken(new Request(cfg.resource,
    { headers: { authorization: 'Bearer ' + access } }), cfg);
  assert.deepEqual(await identity(tokens.access_token), { subject: 'LIGHT', scope: 'metropolis-light' });
  const refresh = await handler(new Request(issuer + '/oauth/token', { method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
      refresh_token: tokens.refresh_token, resource: cfg.resource }) }));
  assert.equal(refresh.status, 200);
  assert.deepEqual(await identity((await refresh.json()).access_token), { subject: 'LIGHT', scope: 'metropolis-light' });
  for (const badId of ['https://app.notion.com/oauth/other.json', 'https://app.notion.com.evil.example/oauth/mcp-client-metadata.json']) {
    const bad = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({ ...params, client_id: badId })));
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { code: 'OAUTH_INVALID_CLIENT' });
  }
  const badRedirect = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({ ...params, redirect_uri: 'https://evil.example/callback' })));
  assert.deepEqual(await badRedirect.json(), { code: 'OAUTH_INVALID_REDIRECT_URI' });
});
function config() {
  const consumed = new Set(), revoked = new Set(), failures = new Map();
  return { issuer, resource: issuer + '/mcp', signingKey: 'test-only-key', ownerPasscode: 'test-only-owner', clientId: 'go', clientSecret: 'test-only-secret', redirectUri: 'https://client.example/callback', subject: 'GO', scope: 'metropolis-go', now: () => 1000,
    ledger: { async consume(key) { if (consumed.has(key)) return false; consumed.add(key); return true; }, async blocked(key, now) { return (failures.get(key) || []).filter(t => now - t < 900).length >= 5; }, async failure(key, now) { failures.set(key, [...(failures.get(key) || []), now]); }, async refreshFamilyRevoked(id) { return revoked.has(id); }, async revokeRefreshFamily(id) { revoked.add(id); } } };
}
function token(form) { return new Request(issuer + '/oauth/token', { method: 'POST', headers: { authorization: 'Basic ' + btoa('go:test-only-secret'), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }); }

test('owner-registered additional actor keeps its identity and scope across refresh', async () => {
  const cfg = {
    ...config(), ownerId: 'BIG',
    clients: [{
      clientId: 'oracle-client', clientSecret: 'oracle-test-secret',
      subject: 'ORACLE', scope: 'metropolis-oracle',
      redirectUris: ['https://oracle.example/callback'],
      resources: [issuer + '/mcp'],
    }],
  };
  const handler = createOAuthHandler(cfg);
  const code = await createTestAuthorizationCode({
    ...cfg, clientId: 'oracle-client', subject: 'BIG',
    actor: 'ORACLE', scope: 'metropolis-oracle',
    redirectUri: 'https://oracle.example/callback',
    codeChallenge: challenge,
  });
  const exchange = await handler(new Request(issuer + '/oauth/token', {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + btoa('oracle-client:oracle-test-secret'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: 'oracle-client',
      code, code_verifier: verifier, redirect_uri: 'https://oracle.example/callback',
      resource: cfg.resource,
    }),
  }));
  assert.equal(exchange.status, 200);
  const tokens = await exchange.json();
  assert.equal(tokens.scope, 'metropolis-oracle');
  const verify = tokenValue => verifyAccessToken(
    new Request(cfg.resource, { headers: { authorization: 'Bearer ' + tokenValue } }),
    { ...cfg, requireClientId: true },
  );
  const identity = {
    subject: 'BIG', owner: 'BIG', actor: 'ORACLE',
    scope: 'metropolis-oracle', delegated: true,
  };
  assert.deepEqual(await verify(tokens.access_token), identity);
  const refresh = await handler(new Request(issuer + '/oauth/token', {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa('oracle-client:oracle-test-secret') },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: 'oracle-client',
      refresh_token: tokens.refresh_token,
      resource: cfg.resource,
    }),
  }));
  assert.equal(refresh.status, 200);
  const rotated = await refresh.json();
  assert.deepEqual(await verify(rotated.access_token), identity);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);

  const unknownActor = await createTestAccessToken({
    ...cfg, clientId: 'oracle-client', subject: 'BIG',
    actor: 'UNREGISTERED', scope: 'metropolis-unregistered',
  });
  await assert.rejects(() => verify(unknownActor));
});

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
test('refresh rotates normally, but reuse of an old token revokes descendants, not unrelated families', async () => {
  const cfg = config(), handler = createOAuthHandler(cfg);
  const firstToken = await createTestRefreshToken(cfg);
  const independentToken = await createTestRefreshToken(cfg);
  const form = value => ({ grant_type: 'refresh_token', refresh_token: value, resource: cfg.resource });
  const first = await handler(token(form(firstToken)));
  assert.equal(first.status, 200);
  const rotated = (await first.json()).refresh_token;
  const second = await handler(token(form(rotated)));
  assert.equal(second.status, 200);
  const newest = (await second.json()).refresh_token;
  assert.notEqual(newest, rotated);
  assert.equal((await handler(token(form(firstToken)))).status, 400);
  assert.equal((await handler(token(form(newest)))).status, 400);
  assert.equal((await handler(token(form(independentToken)))).status, 200);
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

test('known Notion CIMD works without a runtime metadata fetch and pins its callback', async () => {
  const cfg = { ...config(), allowCimd: true,
    fetchImpl: async () => { throw new Error('network unavailable'); } };
  const handler = createOAuthHandler(cfg);
  const params = { response_type: 'code',
    client_id: 'https://app.notion.com/oauth/mcp-client-metadata.json',
    redirect_uri: 'https://app.notion.com/workflows/mcp/oauth/callback',
    code_challenge: challenge, code_challenge_method: 'S256', resource: cfg.resource,
    scope: 'metropolis-light' };
  const response = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams(params)));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /value="LIGHT"/);
  const wrongCallback = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({ ...params, redirect_uri: 'https://app.notion.com/other' })));
  assert.deepEqual(await wrongCallback.json(), { code: 'OAUTH_INVALID_REDIRECT_URI' });
});

test('Observatory native CIMD is pinned to GO and exchanges a GO-only token', async () => {
  const cfg = { ...config(), allowCimd: true };
  const handler = createOAuthHandler(cfg);
  const clientId = `${issuer}/oauth/observatory-client.json`;
  const redirectUri = `${issuer}/oauth/observatory-callback`;
  const metadata = await handler(new Request(clientId));
  assert.equal(metadata.status, 200);
  assert.deepEqual(await metadata.json(), {
    client_id: clientId,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'metropolis-go',
  });
  const params = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
    scope: 'metropolis-go',
    state: 'observatory-state',
  };
  const authorize = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams(params)));
  assert.equal(authorize.status, 200);
  assert.match(await authorize.text(), /Enter as <strong>GO<\/strong>/);
  const wrongActor = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({
    ...params,
    scope: 'metropolis-light',
  })));
  assert.equal(wrongActor.status, 400);

  const consent = await handler(new Request(issuer + '/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, actor: 'GO', passcode: cfg.ownerPasscode }),
  }));
  assert.equal(consent.status, 302);
  const callback = new URL(consent.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, redirectUri);
  assert.equal(callback.searchParams.get('state'), 'observatory-state');
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
  assert.equal(tokens.scope, 'metropolis-go');
  assert.deepEqual(await verifyAccessToken(new Request(cfg.resource, {
    headers: { authorization: 'Bearer ' + tokens.access_token },
  }), { ...cfg, requireClientId: true }), { subject: 'GO', scope: 'metropolis-go' });

  const refresh = await handler(new Request(issuer + '/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId,
      refresh_token: tokens.refresh_token, resource: cfg.resource,
    }),
  }));
  assert.equal(refresh.status, 200);
  const renewed = await refresh.json();
  assert.equal(renewed.scope, 'metropolis-go');
  assert.notEqual(renewed.refresh_token, tokens.refresh_token);
  assert.deepEqual(await verifyAccessToken(new Request(cfg.resource, {
    headers: { authorization: 'Bearer ' + renewed.access_token },
  }), { ...cfg, requireClientId: true }), { subject: 'GO', scope: 'metropolis-go' });

  const wrongId = await handler(new Request(issuer + '/oauth/authorize?' + new URLSearchParams({
    ...params,
    client_id: 'https://evil.example/oauth/observatory-client.json',
  })));
  assert.equal(wrongId.status, 400);
});
