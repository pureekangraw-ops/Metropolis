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
async function createObservatoryWork(gateway) {
  const input = await call(gateway, 'metropolis_reception', {
    action: 'input_information',
    payload: { information: { title: 'Observatory read test' }, ownerSystem: 'OBSERVATORY' },
  });
  const draftId = input.body.result.structuredContent.result.draftId;
  for (const action of ['review', 'ready_to_create']) {
    const result = await call(gateway, 'metropolis_reception', { action, draftId, payload: {} });
    assert.equal(result.body.result.isError, false);
  }
  const created = await call(gateway, 'metropolis_reception', { action: 'create_work', draftId, payload: {} });
  assert.equal(created.body.result.isError, false);
  return created.body.result.structuredContent.result;
}
function accessToken(subject = 'GO') {
  return createTestAccessToken({
    issuer: origin,
    resource: origin + '/mcp',
    signingKey: env.MCP_OAUTH_SIGNING_KEY,
    subject,
    scope: subject === 'GO' ? 'metropolis-go' : 'metropolis-light',
    clientId: subject.toLowerCase(),
  });
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
  assert.equal(JSON.parse(raw).driveStation, 'NOT_CONFIGURED');
  assert.equal(JSON.parse(raw).stationPlan.stations.find(s => s.stationId === 'DRIVE_STATION').runtimeBinding, null);
});

test('Observatory pairing requires authenticated GO and explicit existing READ Work', async () => {
  const durable = storage();
  const gateway = createGateway({ env: { ...env, MCP_WORK_GRANTS: '[]' }, storage: durable, sourceSha: 'a'.repeat(40) });
  const work = await createObservatoryWork(gateway);
  const unauthenticated = await gateway.fetch(new Request(origin + '/observatory/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workId: work.workId }),
  }));
  assert.equal(unauthenticated.status, 401);

  const lightToken = await accessToken('LIGHT');
  const light = await gateway.fetch(new Request(origin + '/observatory/pair', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + lightToken, 'content-type': 'application/json' },
    body: JSON.stringify({ workId: work.workId }),
  }));
  assert.equal(light.status, 403);
  assert.equal((await light.json()).reason, 'GO_REQUIRED');

  const goToken = await accessToken('GO');
  const paired = await gateway.fetch(new Request(origin + '/observatory/pair', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + goToken, 'content-type': 'application/json' },
    body: JSON.stringify({ workId: work.workId }),
  }));
  assert.equal(paired.status, 200);
  const config = await paired.json();
  assert.equal(typeof config.token, 'string');
  assert.equal(config.publishSnapshot, `${origin}/observatory/device/${config.deviceId}/snapshot`);

  const noReadEnv = {
    ...env,
    MCP_WORK_GRANTS: JSON.stringify([{ actor: 'GO', action: 'handoff', workId: work.workId, stationId: '*', operation: '*' }]),
  };
  const noRead = createGateway({ env: noReadEnv, storage: durable, sourceSha: 'a'.repeat(40) });
  const denied = await noRead.fetch(new Request(origin + '/observatory/pair', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + goToken, 'content-type': 'application/json' },
    body: JSON.stringify({ workId: work.workId }),
  }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).reason, 'NO_GRANT');
});

test('Observatory station observation returns a readback receipt without changing Work lifecycle', async () => {
  const durable = storage();
  const gateway = createGateway({ env: { ...env, MCP_WORK_GRANTS: '[]' }, storage: durable, sourceSha: 'a'.repeat(40) });
  const work = await createObservatoryWork(gateway);
  const goToken = await accessToken('GO');
  const paired = await gateway.fetch(new Request(origin + '/observatory/pair', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + goToken, 'content-type': 'application/json' },
    body: JSON.stringify({ workId: work.workId }),
  }));
  const config = await paired.json();
  const now = Date.now();
  const snapshot = {
    schema: 'observer.snapshot.v1',
    captureId: 'browser-capture-01',
    revision: 1,
    sequence: 1,
    epoch: 1,
    capturedAtEpochMs: now,
    tabId: 'tab-01',
    url: 'https://example.com/private?session=remove-me',
    title: 'Example',
    text: 'Useful page evidence',
    targets: [],
    truncated: false,
  };
  const published = await gateway.fetch(new Request(config.publishSnapshot, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json' },
    body: JSON.stringify({ view: 'browser', snapshot }),
  }));
  assert.equal(published.status, 200);
  assert.equal((await published.json()).accepted, true);

  const observed = await call(gateway, 'metropolis_observatory_observe', {
    workId: work.workId,
    view: 'browser',
  });
  assert.equal(observed.body.result.isError, false);
  const result = observed.body.result.structuredContent.stationResult;
  assert.equal(result.stationId, 'OBSERVATORY_STATION');
  assert.equal(result.readbackVerified, true);
  assert.equal(result.receipt.status, 'READBACK_VERIFIED');
  assert.equal(result.receipt.businessOutcome, 'UNKNOWN');
  assert.equal(result.snapshot.url, 'https://example.com/private');
  const read = await call(gateway, 'metropolis_work', { action: 'read', workId: work.workId });
  assert.equal(read.body.result.structuredContent.record.state, 'RECEIVED');
});

test('Observatory observation rejects LIGHT, non-Observatory Work, and missing READ', async () => {
  const durable = storage();
  const gateway = createGateway({ env: { ...env, MCP_WORK_GRANTS: '[]' }, storage: durable, sourceSha: 'a'.repeat(40) });
  const work = await createObservatoryWork(gateway);
  const light = await call(gateway, 'metropolis_observatory_observe', { workId: work.workId, view: 'browser' }, 'LIGHT');
  assert.equal(light.body.result.isError, true);
  assert.equal(light.body.result.structuredContent.reason, 'GO_REQUIRED');

  const restricted = createGateway({
    env: { ...env, MCP_WORK_GRANTS: JSON.stringify([{ actor: 'GO', action: 'handoff', workId: work.workId, stationId: '*', operation: '*' }]) },
    storage: durable,
    sourceSha: 'a'.repeat(40),
  });
  const noRead = await call(restricted, 'metropolis_observatory_observe', { workId: work.workId, view: 'browser' });
  assert.equal(noRead.body.result.isError, true);
  assert.equal(noRead.body.result.structuredContent.reason, 'NO_GRANT');

  const badArgs = await call(gateway, 'metropolis_observatory_observe', {
    workId: work.workId,
    view: 'browser',
    stationId: 'CALLER_CONTROLLED',
  });
  assert.equal(badArgs.body.result.isError, true);
  assert.equal(badArgs.body.result.structuredContent.reason, 'INVALID_ARGUMENT');
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


test('gateway accepts the full explicit Work action set used by LIGHT', async () => {
  const fullGrantEnv = {
    ...env,
    MCP_WORK_GRANTS: JSON.stringify([
      { actor: 'LIGHT', action: 'read', workId: 'W' },
      { actor: 'LIGHT', action: 'handoff', workId: 'W', stationId: '*', operation: '*' },
      { actor: 'LIGHT', action: 'return', workId: 'W' },
      { actor: 'LIGHT', action: 'cancel', workId: 'W' },
      { actor: 'LIGHT', action: 'complete', workId: 'W' },
    ]),
  };
  const gateway = createGateway({ env: fullGrantEnv, storage: storage(), sourceSha: 'a'.repeat(40) });
  const health = await gateway.fetch(new Request(origin + '/health'));
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.status, 'READY');
});

test('configured Drive credentials appear bound but never provider verified before readback', async () => {
  const configuredEnv = {
    ...env,
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_REFRESH_TOKEN: 'test-refresh-token',
    GOOGLE_DRIVE_ROOT_FOLDER_ID: 'DRIVEFOLDER_000000001',
    TABLET_STORAGE: { get: async () => null, put: async () => null },
  };
  const gateway = createGateway({ env: configuredEnv, storage: storage(), sourceSha: 'a'.repeat(40) });
  const response = await gateway.fetch(new Request(origin + '/health'));
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.driveStation, 'BOUND_UNVERIFIED');
  const drive = health.stationPlan.stations.find(s => s.stationId === 'DRIVE_STATION');
  assert.equal(drive.runtimeBinding.kind, 'GOOGLE_DRIVE_OAUTH');
  assert.equal(drive.runtimeBinding.verified, false);
  assert.equal(JSON.stringify(health).includes('test-client-secret'), false);
  assert.equal(JSON.stringify(health).includes('test-refresh-token'), false);
});
