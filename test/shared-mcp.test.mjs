import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetropolisMcp } from '../src/shared-mcp.mjs';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';

const origin = 'https://city.example';
const auth = async request => ({ actor: request.headers.get('authorization') === 'Bearer light' ? 'LIGHT' : request.headers.get('authorization') === 'Bearer go' ? 'GO' : null });
const grant = { actor: 'GO', action: 'read', workId: 'W1' };
function service(sourceSha = 'release-one', runtime = createCityRuntime(), grants = [grant]) {
  return createMetropolisMcp({ runtime, authenticate: auth, grants, sourceSha, version: '1.0.0', allowedOrigins: [origin] });
}
async function rpc(server, method, params = {}, token = 'go', id = 1) {
  return server.fetch(new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }));
}
async function arrive(server, token = 'go') {
  return (await (await rpc(server, 'tools/call', { name: 'metropolis_arrive', arguments: {} }, token)).json()).result.structuredContent;
}
test('same MCP entry identifies GO and LIGHT while discovery stays available before linking', async () => {
  assert.equal((await arrive(service())).actor, 'GO');
  assert.equal((await arrive(service(), 'light')).actor, 'LIGHT');

  const listed = await rpc(service(), 'tools/list', {}, 'invalid');
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.ok(listedBody.result.tools.every(tool => tool.securitySchemes?.some(scheme => scheme.type === 'oauth2')));

  const unauthenticated = await (await rpc(service(), 'tools/call', { name: 'metropolis_arrive', arguments: {} }, 'invalid')).json();
  assert.equal(unauthenticated.result.isError, true);
  assert.equal(unauthenticated.result.structuredContent.reason, 'AUTH_REQUIRED');
  assert.match(unauthenticated.result._meta['mcp/www_authenticate'][0], /resource_metadata=/);
  assert.match(unauthenticated.result._meta['mcp/www_authenticate'][0], /error_description=/);
});
test('profile tool exposes stable distinct GO and LIGHT connection identities', async () => {
  const server = service();
  const go = (await (await rpc(server, 'tools/call', { name: 'metropolis_identity', arguments: {} }, 'go')).json()).result;
  const light = (await (await rpc(server, 'tools/call', { name: 'metropolis_identity', arguments: {} }, 'light')).json()).result;
  assert.equal(go.isError, false);
  assert.equal(light.isError, false);
  assert.equal(go.structuredContent.name, 'GO');
  assert.equal(light.structuredContent.name, 'LIGHT');
  assert.ok(go.structuredContent.id);
  assert.ok(light.structuredContent.id);
  assert.notEqual(go.structuredContent.id, light.structuredContent.id);

  const listed = await (await rpc(server, 'tools/list', {}, 'invalid')).json();
  const profileDescriptor = listed.result.tools.find(tool => tool.name === 'metropolis_identity');
  assert.equal(profileDescriptor._meta['openai/profile'], true);
  assert.equal(profileDescriptor.outputSchema.required.includes('id'), true);
});

test('old room receives current schemas without creating another session', async () => {
  const old = await arrive(service('release-one'));
  const current = await arrive(service('release-two'));
  assert.notEqual(old.schemaHash, current.schemaHash);
  assert.equal(current.sourceSha, 'release-two');
  assert.deepEqual(current.tools.map(t => t.name), ['metropolis_identity', 'metropolis_arrive', 'metropolis_work']);
  assert.equal(current.refresh.transportNotificationSupported, false);
});
test('arrival refreshes schema and shows only authorized current Work pointers without creating Work', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', checkpointId: 'CP-LIVE', ownerSystem: 'FACTORY', requestedBy: 'GO', inputRefs: ['private://payload'] });
  const server = service('one', runtime, [
    { actor: 'GO', action: 'read', workId: 'W1' },
    { actor: 'GO', action: 'intake', workId: 'W2', ownerSystem: 'FACTORY' },
  ]);
  const manifest = await arrive(server);
  assert.equal(manifest.current.release.sourceSha, 'one');
  assert.equal(manifest.reception.staff.id, 'HERMES');
  assert.equal(manifest.reception.lostAndFound.candidates.some(item => item.workId === 'W1'), true);
  assert.equal(manifest.current.schema.schemaHash, manifest.schemaHash);
  assert.equal(manifest.current.schema.mode, 'FRESH_ON_ARRIVAL');
  assert.equal(manifest.refresh.currentSnapshotIncluded, true);

  const live = manifest.current.works.find(work => work.workId === 'W1');
  assert.deepEqual(live.authorizedActions, ['read']);
  assert.equal(live.present, true);
  assert.equal(live.state, 'RECEIVED');
  assert.equal(live.checkpointId, 'CP-LIVE');
  assert.equal(live.ownerSystem, 'FACTORY');
  assert.equal(Object.hasOwn(live, 'inputRefs'), false);

  const pending = manifest.current.works.find(work => work.workId === 'W2');
  assert.deepEqual(pending.authorizedActions, ['intake']);
  assert.equal(pending.present, false);
  assert.equal(pending.state, 'UNKNOWN');
  assert.equal(await runtime.getWork('W2'), undefined);

  const light = await arrive(server, 'light');
  assert.deepEqual(light.current.works, []);
});

test('current server schema governs Work calls without a client schema echo', async () => {
  const store = createMemoryStore();
  const runtime = createCityRuntime({ store });
  await arrive(service('old'));
  const server = service('new', runtime, [{ actor: 'GO', action: 'intake', workId: 'W1', ownerSystem: 'FACTORY' }]);
  const reply = await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'intake', workId: 'W1', payload: {} } })).json();
  assert.equal(reply.result.isError, false);
  assert.equal(reply.result.structuredContent.record.ownerSystem, 'FACTORY');
  assert.equal(reply.result.structuredContent.record.checkpointId, 'W1:CP-01');
});
test('Work identity and server-owned checkpoint survive intake and readback', async () => {
  const runtime = createCityRuntime();
  const server = service('one', runtime, [{ actor: 'GO', action: 'intake', workId: 'W1', ownerSystem: 'FACTORY' }, grant]);
  await arrive(server);
  const intake = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'intake', workId: 'W1', payload: {} } })).json()).result;
  assert.equal(intake.isError, false);
  assert.equal(intake.structuredContent.record.checkpointId, 'W1:CP-01');
  assert.equal(intake.structuredContent.record.ownerSystem, 'FACTORY');
  assert.equal(intake.structuredContent.record.requestedBy, 'GO');
  assert.equal(intake.structuredContent.readbackVerified, true);
  const read = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'read', workId: 'W1' } })).json()).result;
  assert.equal(read.structuredContent.record.workId, 'W1');
});
test('LIGHT cannot reuse GO grant or self-declare GO identity', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime);
  await arrive(server, 'light');
  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'read', workId: 'W1', payload: { actor: 'GO' } } }, 'light')).json()).result;
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.reason, 'NO_GRANT');
});
test('read uses the current Work context without caller checkpoint input', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime);
  await arrive(server);
  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'read', workId: 'W1' } })).json()).result;
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.record.checkpointId, 'W1:CP-01');
});
test('rejects foreign browser origins and unsupported transport versions', async () => {
  const request = new Request(origin + '/mcp', { method: 'POST', headers: { origin: 'https://evil.example', authorization: 'Bearer go' }, body: '{}' });
  assert.equal((await service().fetch(request)).status, 403);
  const response = await rpc(service(), 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal((await response.json()).result.protocolVersion, '2025-03-26');
  assert.equal((await rpc(service(), 'initialize', { protocolVersion: 'unsupported' })).status, 400);
});
test('MCP notifications have no JSON-RPC response', async () => {
  const notification = new Request(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer go', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  const accepted = await service().fetch(notification);
  assert.equal(accepted.status, 202);
  assert.equal(await accepted.text(), '');
});
test('return records evidence without accepting an agent claim of verified execution', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime, [{ actor: 'GO', action: 'return', workId: 'W1' }]);
  await arrive(server);
  const review = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'return', workId: 'W1', payload: { verified: true, evidenceRefs: ['evidence://one'] } } })).json()).result;
  assert.equal(review.structuredContent.record.return, null);
  assert.equal(review.structuredContent.record.returnReview.status, 'CONFIRMATION_REQUIRED');
  assert.equal(review.structuredContent.ownerExecutionVerified, false);

  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'return', workId: 'W1', payload: { evidenceRefs: ['evidence://one'], confirmation: 'CONFIRM_RETURN' } } })).json()).result;
  assert.equal(reply.structuredContent.record.return.verified, false);
  assert.equal(reply.structuredContent.record.returnReview.status, 'CONFIRMED');
  assert.equal(reply.structuredContent.ownerExecutionVerified, false);
});
test('handoff cannot widen its destination or override its Work identity', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime, [{ actor: 'GO', action: 'handoff', workId: 'W1', stationId: 'FACTORY_STATION', operation: 'CODE' }]);
  await arrive(server);
  const args = { action: 'handoff', workId: 'W1', payload: { stationId: 'OTHER_STATION', operation: 'CODE' } };
  const denied = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: args })).json()).result;
  assert.equal(denied.structuredContent.reason, 'DESTINATION_NOT_GRANTED');
  args.payload.stationId = 'FACTORY_STATION';
  args.payload.workId = 'W2';
  args.payload.actor = 'LIGHT';
  const accepted = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: args })).json()).result;
  assert.equal(accepted.structuredContent.record.workId, 'W1');
  assert.equal(accepted.structuredContent.record.handoff.actor, 'GO');
  assert.equal(Object.hasOwn(accepted.structuredContent.record.handoff, 'railId'), false);
});
