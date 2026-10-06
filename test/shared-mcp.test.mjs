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
test('same MCP entry identifies GO and LIGHT from authentication', async () => {
  assert.equal((await arrive(service())).actor, 'GO');
  assert.equal((await arrive(service(), 'light')).actor, 'LIGHT');
  assert.equal((await rpc(service(), 'tools/list', {}, 'invalid')).status, 401);
});
test('old room receives current schemas without creating another session', async () => {
  const old = await arrive(service('release-one'));
  const current = await arrive(service('release-two'));
  assert.notEqual(old.schemaHash, current.schemaHash);
  assert.equal(current.sourceSha, 'release-two');
  assert.deepEqual(current.tools.map(t => t.name), ['metropolis_arrive', 'metropolis_work']);
  assert.equal(current.refresh.transportNotificationSupported, false);
});
test('stale schema blocks writes and returns current station manifest', async () => {
  const store = createMemoryStore();
  const runtime = createCityRuntime({ store });
  const old = await arrive(service('old'));
  const server = service('new', runtime, [{ actor: 'GO', action: 'intake', workId: 'W1', ownerSystem: 'FACTORY' }]);
  const reply = await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'intake', workId: 'W1', checkpointId: 'CP-EXISTING', schemaHash: old.schemaHash, payload: { ownerSystem: 'FACTORY' } } })).json();
  assert.equal(reply.result.isError, true);
  assert.equal(reply.result.structuredContent.reason, 'SCHEMA_REFRESH_REQUIRED');
  assert.equal(reply.result.structuredContent.current.sourceSha, 'new');
  assert.equal(await runtime.getWork('W1'), undefined);
});
test('Work identity and supplied checkpoint survive intake and readback', async () => {
  const runtime = createCityRuntime();
  const server = service('one', runtime, [{ actor: 'GO', action: 'intake', workId: 'W1', ownerSystem: 'FACTORY' }, grant]);
  const manifest = await arrive(server);
  const args = { schemaHash: manifest.schemaHash, action: 'intake', workId: 'W1', checkpointId: 'CP-ORIGINAL', payload: { ownerSystem: 'FACTORY' } };
  const intake = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: args })).json()).result;
  assert.equal(intake.isError, false);
  assert.equal(intake.structuredContent.record.checkpointId, 'CP-ORIGINAL');
  assert.equal(intake.structuredContent.record.requestedBy, 'GO');
  assert.equal(intake.structuredContent.readbackVerified, true);
  const read = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { ...args, action: 'read', payload: {} } })).json()).result;
  assert.equal(read.structuredContent.record.workId, 'W1');
});
test('LIGHT cannot reuse GO grant or self-declare GO identity', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime);
  const manifest = await arrive(server, 'light');
  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'read', workId: 'W1', checkpointId: 'W1:CP-01', schemaHash: manifest.schemaHash, payload: { actor: 'GO' } } }, 'light')).json()).result;
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.reason, 'NO_GRANT');
});
test('read requires same checkpoint and does not reveal another Work', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime);
  const manifest = await arrive(server);
  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { action: 'read', workId: 'W1', checkpointId: 'wrong', schemaHash: manifest.schemaHash } })).json()).result;
  assert.equal(reply.structuredContent.reason, 'CHECKPOINT_MISMATCH');
  assert.equal(reply.structuredContent.record, undefined);
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
  const manifest = await arrive(server);
  const reply = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: { schemaHash: manifest.schemaHash, action: 'return', workId: 'W1', checkpointId: 'W1:CP-01', payload: { verified: true, evidenceRefs: ['evidence://one'] } } })).json()).result;
  assert.equal(reply.structuredContent.record.return.verified, false);
  assert.equal(reply.structuredContent.ownerExecutionVerified, false);
});
test('handoff cannot widen its destination or override its Work identity', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime, [{ actor: 'GO', action: 'handoff', workId: 'W1', stationId: 'FACTORY_STATION', railId: 'FACTORY_RAIL', operation: 'CODE' }]);
  const manifest = await arrive(server);
  const args = { schemaHash: manifest.schemaHash, action: 'handoff', workId: 'W1', checkpointId: 'W1:CP-01', payload: { stationId: 'OTHER_STATION', railId: 'FACTORY_RAIL', operation: 'CODE' } };
  const denied = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: args })).json()).result;
  assert.equal(denied.structuredContent.reason, 'DESTINATION_NOT_GRANTED');
  args.payload.stationId = 'FACTORY_STATION';
  args.payload.workId = 'W2';
  args.payload.actor = 'LIGHT';
  const accepted = (await (await rpc(server, 'tools/call', { name: 'metropolis_work', arguments: args })).json()).result;
  assert.equal(accepted.structuredContent.record.workId, 'W1');
  assert.equal(accepted.structuredContent.record.handoff.actor, 'GO');
});
