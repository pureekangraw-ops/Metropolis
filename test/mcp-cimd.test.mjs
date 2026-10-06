import test from 'node:test';
import assert from 'node:assert/strict';
import { createOAuthHandler, verifyAccessToken } from '../src/mcp-oauth.mjs';

const issuer = 'https://city.example';
const clientId = 'https://chatgpt.com/oauth/client.json';
const redirectUri = 'https://chatgpt.com/connector_platform_oauth_redirect';
const verifier = 'v'.repeat(64);
const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))).toString('base64url');

function config() {
  const consumed = new Set();
  const failures = new Map();
  return {
    issuer,
    resource: issuer + '/mcp',
    signingKey: 'test-only-signing',
    ownerPasscode: 'test-only-owner',
    clients: [],
    allowCimd: true,
    now: () => 1000,
    fetchImpl: async url => {
      if (url !== clientId) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        client_id: clientId,
        redirect_uris: [redirectUri],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    ledger: {
      async consume(key) {
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
      async blocked(key, now) {
        return (failures.get(key) || []).filter(t => now - t < 900).length >= 5;
      },
      async failure(key, now) {
        failures.set(key, [...(failures.get(key) || []), now]);
      },
    },
  };
}

function authorizeRequest(actor, scope = '') {
  return new Request(issuer + '/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '192.0.2.10' },
    body: new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: issuer + '/mcp',
      scope,
      actor,
      passcode: 'test-only-owner',
    }),
  });
}

async function exchange(handler, code) {
  return handler(new Request(issuer + '/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: issuer + '/mcp',
    }),
  }));
}

async function authorizeAndExchange(handler, actor, scope = '') {
  const authorized = await handler(authorizeRequest(actor, scope));
  assert.equal(authorized.status, 302);
  const code = new URL(authorized.headers.get('location')).searchParams.get('code');
  assert.ok(code);
  const tokenResponse = await exchange(handler, code);
  assert.equal(tokenResponse.status, 200);
  return tokenResponse.json();
}

test('OAuth metadata advertises CIMD and PKCE without requiring a static client', async () => {
  const handler = createOAuthHandler(config());
  const response = await handler(new Request(issuer + '/.well-known/oauth-authorization-server'));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.client_id_metadata_document_supported, true);
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  assert.ok(body.token_endpoint_auth_methods_supported.includes('none'));
  assert.ok(body.scopes_supported.includes('metropolis-go'));
  assert.ok(body.scopes_supported.includes('metropolis-light'));
});

test('CIMD public client can authorize separately as GO and LIGHT without a client secret', async () => {
  const cfg = config();
  const handler = createOAuthHandler(cfg);

  const go = await authorizeAndExchange(handler, 'GO');
  assert.equal(go.scope, 'metropolis-go');
  assert.deepEqual(
    await verifyAccessToken(new Request(cfg.resource, { headers: { authorization: 'Bearer ' + go.access_token } }), { ...cfg, requireClientId: true }),
    { subject: 'GO', scope: 'metropolis-go' },
  );

  const light = await authorizeAndExchange(handler, 'LIGHT');
  assert.equal(light.scope, 'metropolis-light');
  assert.deepEqual(
    await verifyAccessToken(new Request(cfg.resource, { headers: { authorization: 'Bearer ' + light.access_token } }), { ...cfg, requireClientId: true }),
    { subject: 'LIGHT', scope: 'metropolis-light' },
  );
});

test('CIMD scope pins actor identity and prevents actor switching', async () => {
  const handler = createOAuthHandler(config());
  const response = await handler(authorizeRequest('LIGHT', 'metropolis-go'));
  assert.equal(response.status, 302);
  const code = new URL(response.headers.get('location')).searchParams.get('code');
  const tokenResponse = await exchange(handler, code);
  const tokens = await tokenResponse.json();
  assert.equal(tokens.scope, 'metropolis-go');
});

test('unknown client metadata URLs and wrong redirects fail closed', async () => {
  const cfg = config();
  const handler = createOAuthHandler(cfg);
  const evil = new URL(issuer + '/oauth/authorize');
  evil.search = new URLSearchParams({
    response_type: 'code',
    client_id: 'https://evil.example/client.json',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
  });
  assert.equal((await handler(new Request(evil))).status, 400);

  const wrong = new URL(issuer + '/oauth/authorize');
  wrong.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://chatgpt.com/not-the-registered-callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: cfg.resource,
  });
  assert.equal((await handler(new Request(wrong))).status, 400);
});
