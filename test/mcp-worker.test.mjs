import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, bufferRequest } from '../src/mcp-worker.mjs';
import { createTestAccessToken } from '../src/mcp-oauth.mjs';
const origin = 'https://city.example';
function storage() {
  const data = new Map();
  return {
    async get(k) { return structuredClone(data.get(k)); },
    async put(k, v) { data.set(k, structuredClone(v)); },
    async list({ prefix = '' } = {}) {
      return new Map(
        [...data.entries()]
          .filter(([key]) => String(key).startsWith(prefix))
          .map(([key, value]) => [key, structuredClone(value)]),
      );
    },
    async transaction(fn) { return fn(this); },
  };
}
const env = { MCP_PUBLIC_ORIGIN: origin, MCP_OAUTH_SIGNING_KEY: 'test-only-signing', MCP_OWNER_PASSCODE: 'test-only-owner', MCP_OAUTH_CLIENTS: JSON.stringify([{ clientId: 'go', clientSecret: 'test-secret-go', subject: 'GO', scope: 'metropolis-go', redirectUris: ['https://client.example/go'] }, { clientId: 'light', clientSecret: 'test-secret-light', subject: 'LIGHT', scope: 'metropolis-light', redirectUris: ['https://client.example/light'] }]), MCP_WORK_GRANTS: JSON.stringify([{ actor: 'GO', action: 'read', workId: 'W' }]) };
async function call(gateway, name, args, subject = 'GO') {
  const token = await createTestAccessToken({ issuer: origin, resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject, scope: subject === 'GO' ? 'metropolis-go' : 'metropolis-light', clientId: subject.toLowerCase() });
  const response = await gateway.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  return { response, body: await response.json() };
}
test('Work created by HERMES survives a fresh gateway on the same durable storage', async () => {
  const durable = storage();
  const first = createGateway({ env: { ...env, MCP_WORK_GRANTS: '[]' }, storage: durable, sourceSha: 'a'.repeat(40) });
  await call(first, 'metropolis_arrive', {});

  const input = await call(first, 'metropolis_reception', {
    action: 'input_information',
    payload: { information: { title: 'Persistent work' }, ownerSystem: 'FACTORY' },
  });
  assert.equal(input.body.result.isError, false);
  const draftId = input.body.result.structuredContent.result.draftId;

  assert.equal((await call(first, 'metropolis_reception', {
    action: 'review', draftId, payload: {},
  })).body.result.isError, false);

  assert.equal((await call(first, 'metropolis_reception', {
    action: 'ready_to_create', draftId, payload: {},
  })).body.result.isError, false);

  const created = await call(first, 'metropolis_reception', {
    action: 'create_work', draftId, payload: {},
  });
  assert.equal(created.body.result.isError, false);
  const workId = created.body.result.structuredContent.result.workId;
  const checkpointId = created.body.result.structuredContent.result.checkpointId;

  const nextEnv = {
    ...env,
    MCP_WORK_GRANTS: '[]',
  };
  const next = createGateway({ env: nextEnv, storage: durable, sourceSha: 'a'.repeat(40) });
  const arrived = await call(next, 'metropolis_arrive', {});
  const pointer = arrived.body.result.structuredContent.current.works.find(work => work.workId === workId);
  assert.equal(pointer.accessSource, 'PERSISTED_WORK_PASS');
  assert.deepEqual(pointer.authorizedActions, ['read', 'handoff', 'return', 'cancel', 'complete']);

  const read = await call(next, 'metropolis_work', { action: 'read', workId });
  assert.equal(read.body.result.isError, false);
  assert.equal(read.body.result.structuredContent.record.checkpointId, checkpointId);
});
test('shared gateway verifies LIGHT scope and rejects legacy issuer', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  assert.equal((await call(gateway, 'metropolis_arrive', {}, 'LIGHT')).body.result.structuredContent.actor, 'LIGHT');
  const old = await createTestAccessToken({ issuer: 'https://old.example', resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject: 'GO', scope: 'metropolis-go' });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + old, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'metropolis_arrive', arguments: {} } }),
  }));
  assert.equal(response.status, 401);
  const denied = await response.json();
  assert.equal(denied.reason, 'AUTH_REQUIRED');
  assert.match(response.headers.get('www-authenticate') || '', /resource_metadata="https:\/\/city\.example\/\.well-known\/oauth-protected-resource"/);
});
test('missing configuration and unknown source never advertise READY', async () => {
  const bad = createGateway({ env: {}, storage: storage(), sourceSha: 'UNKNOWN' });
  assert.equal((await bad.fetch(new Request(origin + '/health'))).status, 503);
  assert.equal((await bad.fetch(new Request(origin + '/mcp', { method: 'POST' }))).status, 503);
});
test('MCP entry advertises OAuth with an HTTP 401 challenge before initialize', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: {
      origin: 'https://chatgpt.com',
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
  }));
  assert.equal(response.status, 401);
  assert.equal((await response.json()).reason, 'AUTH_REQUIRED');
  assert.match(response.headers.get('www-authenticate') || '', /resource_metadata="https:\/\/city\.example\/\.well-known\/oauth-protected-resource"/);
});

test('authenticated ChatGPT origin reaches the MCP service', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const token = await createTestAccessToken({ issuer: origin, resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject: 'GO', scope: 'metropolis-go', clientId: 'go' });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: {
      origin: 'https://chatgpt.com',
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }),
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.name, 'metropolis');
});

test('OAuth discovery stays public even when the client sends a foreign Origin header', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const response = await gateway.fetch(new Request(origin + '/.well-known/oauth-authorization-server', {
    headers: { origin: 'https://chatgpt.com' },
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.issuer, origin);
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
});

test('health reports build identity without credentials', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const response = await gateway.fetch(new Request(origin + '/health'));
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.equal(JSON.parse(raw).sourceSha, 'a'.repeat(40));
  assert.equal(raw.includes('test-only'), false);
});
test('one registered client can connect before LIGHT onboarding', async () => {
  const goOnly = { ...env, MCP_OAUTH_CLIENTS: JSON.stringify(JSON.parse(env.MCP_OAUTH_CLIENTS).slice(0, 1)) };
  const gateway = createGateway({ env: goOnly, storage: storage(), sourceSha: 'a'.repeat(40) });
  assert.equal((await gateway.fetch(new Request(origin + '/health'))).status, 200);
  assert.equal((await call(gateway, 'metropolis_arrive', {})).body.result.structuredContent.actor, 'GO');
  const denied = await call(gateway, 'metropolis_arrive', {}, 'LIGHT');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.reason, 'AUTH_REQUIRED');
});
test('CIMD entry stays ready when optional static client configuration is empty or unusable', async () => {
  const variants = [
    { ...env, MCP_OAUTH_CLIENTS: '[]' },
    { ...env, MCP_OAUTH_CLIENTS: '{not-json' },
    { ...env, MCP_OAUTH_CLIENTS: JSON.stringify({ clientId: 'go' }) },
    { ...env, MCP_OAUTH_CLIENTS: JSON.stringify([JSON.parse(env.MCP_OAUTH_CLIENTS)[0], JSON.parse(env.MCP_OAUTH_CLIENTS)[0]]) },
  ];
  for (const candidate of variants) {
    const gateway = createGateway({ env: candidate, storage: storage(), sourceSha: 'a'.repeat(40) });
    assert.equal((await gateway.fetch(new Request(origin + '/health'))).status, 200);
    const metadata = await (await gateway.fetch(new Request(origin + '/.well-known/oauth-authorization-server'))).json();
    assert.equal(metadata.client_id_metadata_document_supported, true);
  }
});
test('a GO subject cannot authenticate with the LIGHT client identity', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const wrongClient = await createTestAccessToken({ issuer: origin, resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject: 'GO', scope: 'metropolis-go', clientId: 'light' });
  const response = await gateway.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + wrongClient, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'metropolis_arrive', arguments: {} } }),
  }));
  assert.equal(response.status, 401);
  const denied = await response.json();
  assert.equal(denied.reason, 'AUTH_REQUIRED');
});
test('slow and oversized public bodies stop before the durable entry gate', async () => {
  const slow = new Request(origin + '/oauth/authorize', { method: 'POST', body: new ReadableStream({ start() {} }), duplex: 'half' });
  await assert.rejects(bufferRequest(slow, { timeoutMs: 10 }), /BODY_TIMEOUT/);
  const large = new Request(origin + '/oauth/authorize', { method: 'POST', body: 'x'.repeat(65537) });
  await assert.rejects(bufferRequest(large), /BODY_TOO_LARGE/);
  const small = new Request(origin + '/oauth/authorize', { method: 'POST', body: 'passcode=example' });
  assert.equal(await (await bufferRequest(small)).text(), 'passcode=example');
});
