import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway, bufferRequest } from '../src/mcp-worker.mjs';
import { createTestAccessToken } from '../src/mcp-oauth.mjs';
const origin = 'https://city.example';
function storage() {
  const data = new Map();
  return { async get(k) { return structuredClone(data.get(k)); }, async put(k, v) { data.set(k, structuredClone(v)); }, async transaction(fn) { return fn(this); } };
}
const env = { MCP_PUBLIC_ORIGIN: origin, MCP_OAUTH_SIGNING_KEY: 'test-only-signing', MCP_OWNER_PASSCODE: 'test-only-owner', MCP_OAUTH_CLIENTS: JSON.stringify([{ clientId: 'go', clientSecret: 'test-secret-go', subject: 'GO', scope: 'metropolis-go', redirectUris: ['https://client.example/go'] }, { clientId: 'light', clientSecret: 'test-secret-light', subject: 'LIGHT', scope: 'metropolis-light', redirectUris: ['https://client.example/light'] }]), MCP_WORK_GRANTS: JSON.stringify([{ actor: 'GO', action: 'intake', workId: 'W', ownerSystem: 'FACTORY' }, { actor: 'GO', action: 'read', workId: 'W' }]) };
async function call(gateway, name, args, subject = 'GO') {
  const token = await createTestAccessToken({ issuer: origin, resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject, scope: subject === 'GO' ? 'metropolis-go' : 'metropolis-light', clientId: subject.toLowerCase() });
  const response = await gateway.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  return { response, body: await response.json() };
}
test('Work survives a fresh gateway on the same durable storage', async () => {
  const durable = storage();
  const first = createGateway({ env, storage: durable, sourceSha: 'a'.repeat(40) });
  const manifest = (await call(first, 'metropolis_arrive', {})).body.result.structuredContent;
  const args = { schemaHash: manifest.schemaHash, action: 'intake', workId: 'W', checkpointId: 'CP', payload: { ownerSystem: 'FACTORY' } };
  assert.equal((await call(first, 'metropolis_work', args)).body.result.isError, false);
  const next = createGateway({ env, storage: durable, sourceSha: 'a'.repeat(40) });
  const read = await call(next, 'metropolis_work', { ...args, action: 'read' });
  assert.equal(read.body.result.structuredContent.record.checkpointId, 'CP');
});
test('shared gateway verifies LIGHT scope and rejects legacy issuer', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  assert.equal((await call(gateway, 'metropolis_arrive', {}, 'LIGHT')).body.result.structuredContent.actor, 'LIGHT');
  const old = await createTestAccessToken({ issuer: 'https://old.example', resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject: 'GO', scope: 'metropolis-go' });
  const response = await gateway.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + old } }));
  assert.equal(response.status, 401);
});
test('missing configuration and unknown source never advertise READY', async () => {
  const bad = createGateway({ env: {}, storage: storage(), sourceSha: 'UNKNOWN' });
  assert.equal((await bad.fetch(new Request(origin + '/health'))).status, 503);
  assert.equal((await bad.fetch(new Request(origin + '/mcp', { method: 'POST' }))).status, 503);
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
  assert.equal((await call(gateway, 'metropolis_arrive', {}, 'LIGHT')).response.status, 401);
});
test('empty static clients allow CIMD while invalid static registration fails closed', async () => {
  const noStatic = createGateway({ env: { ...env, MCP_OAUTH_CLIENTS: '[]' }, storage: storage(), sourceSha: 'a'.repeat(40) });
  assert.equal((await noStatic.fetch(new Request(origin + '/health'))).status, 200);
  const clients = JSON.parse(env.MCP_OAUTH_CLIENTS);
  for (const invalid of [[clients[0], clients[0]], { clientId: 'go' }]) {
    const gateway = createGateway({ env: { ...env, MCP_OAUTH_CLIENTS: JSON.stringify(invalid) }, storage: storage(), sourceSha: 'a'.repeat(40) });
    assert.equal((await gateway.fetch(new Request(origin + '/health'))).status, 503);
  }
});
test('a GO subject cannot authenticate with the LIGHT client identity', async () => {
  const gateway = createGateway({ env, storage: storage(), sourceSha: 'a'.repeat(40) });
  const wrongClient = await createTestAccessToken({ issuer: origin, resource: origin + '/mcp', signingKey: env.MCP_OAUTH_SIGNING_KEY, subject: 'GO', scope: 'metropolis-go', clientId: 'light' });
  const response = await gateway.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + wrongClient } }));
  assert.equal(response.status, 401);
});
test('slow and oversized public bodies stop before the durable entry gate', async () => {
  const slow = new Request(origin + '/oauth/authorize', { method: 'POST', body: new ReadableStream({ start() {} }), duplex: 'half' });
  await assert.rejects(bufferRequest(slow, { timeoutMs: 10 }), /BODY_TIMEOUT/);
  const large = new Request(origin + '/oauth/authorize', { method: 'POST', body: 'x'.repeat(65537) });
  await assert.rejects(bufferRequest(large), /BODY_TOO_LARGE/);
  const small = new Request(origin + '/oauth/authorize', { method: 'POST', body: 'passcode=example' });
  assert.equal(await (await bufferRequest(small)).text(), 'passcode=example');
});
