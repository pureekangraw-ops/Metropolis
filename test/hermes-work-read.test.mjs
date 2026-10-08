import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';
import { createMetropolisMcp } from '../src/shared-mcp.mjs';
import { createHermesWorkReader } from '../src/agents/hermes/work-reader.mjs';

const origin = 'https://city.example';
const auth = async request => ({
  actor: request.headers.get('authorization') === 'Bearer light' ? 'LIGHT' : 'GO',
});
const rpc = async (server, name, args, token = 'go') => {
  const response = await server.fetch(new Request(origin + '/mcp', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + token,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  }));
  return (await response.json()).result;
};
const service = (runtime, grants = []) => createMetropolisMcp({
  runtime, authenticate: auth, grants, allowedOrigins: [origin], sourceSha: 'hermes-reader-test',
});

test('HERMES read-only tool is discoverable and does not request additional authority', async () => {
  const server = service(createCityRuntime());
  const response = await server.fetch(new Request(origin + '/mcp', {
    method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }));
  const tool = (await response.json()).result.tools.find(item => item.name === 'metropolis_hermes_read');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['workId']);
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
});

test('GO asks HERMES to read one authorized Work without mutating its truth', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({ workId: 'W-GO-READ', ownerSystem: 'FACTORY', workPassActor: 'GO' });
  const server = service(runtime);
  const before = await runtime.getWork('W-GO-READ');
  const reply = await rpc(server, 'metropolis_hermes_read', { workId: 'W-GO-READ' });
  assert.equal(reply.isError, false);
  const result = reply.structuredContent;
  assert.equal(result.actor, 'GO');
  assert.equal(result.handledBy, 'HERMES');
  assert.equal(result.receipt.requestedBy, 'GO');
  assert.equal(result.receipt.handledBy, 'HERMES');
  assert.equal(result.receipt.persisted, false);
  assert.equal(result.readbackVerified, true);
  assert.equal(result.workTruthChanged, false);
  assert.equal(result.record.workId, 'W-GO-READ');
  assert.deepEqual(await runtime.getWork('W-GO-READ'), before);
});

test('HERMES cannot read across caller Work Pass or explicit permissions', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({ workId: 'W-GO-ONLY', ownerSystem: 'FACTORY', workPassActor: 'GO' });
  const server = service(runtime);
  const denied = await rpc(server, 'metropolis_hermes_read', { workId: 'W-GO-ONLY' }, 'light');
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.reason, 'NO_GRANT');
  assert.equal(Object.hasOwn(denied.structuredContent, 'record'), false);

  const override = service(runtime, [{ actor: 'GO', action: 'complete', workId: 'W-GO-ONLY' }]);
  const deniedExplicit = await rpc(override, 'metropolis_hermes_read', { workId: 'W-GO-ONLY' });
  assert.equal(deniedExplicit.isError, true);
  assert.equal(deniedExplicit.structuredContent.reason, 'NO_GRANT');
  const wrongArgs = await rpc(server, 'metropolis_hermes_read', { workId: 'W-GO-ONLY', actor: 'LIGHT' });
  assert.equal(wrongArgs.isError, true);
  assert.equal(wrongArgs.structuredContent.reason, 'INVALID_ARGUMENT');
});

test('Legacy WORK READ also delegates to HERMES while preserving existing result fields', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({ workId: 'W-LEGACY', ownerSystem: 'GO', workPassActor: 'GO' });
  const server = service(runtime);
  const reply = await rpc(server, 'metropolis_work', { action: 'read', workId: 'W-LEGACY' });
  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.actor, 'GO');
  assert.equal(reply.structuredContent.handledBy, 'HERMES');
  assert.equal(reply.structuredContent.readbackVerified, true);
  assert.equal(reply.structuredContent.record.workId, 'W-LEGACY');
  assert.equal(reply.structuredContent.workTruthChanged, false);
});

test('HERMES can read a completed Work using the closed read-only Work Pass', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({ workId: 'W-CLOSED', ownerSystem: 'GO', workPassActor: 'GO' });
  await runtime.completeWork({ workId: 'W-CLOSED', actor: 'MIMIR', requestedBy: 'GO' });
  const result = await rpc(service(runtime), 'metropolis_hermes_read', { workId: 'W-CLOSED' });
  assert.equal(result.isError, false);
  assert.equal(result.structuredContent.record.state, 'COMPLETED');
  assert.equal(result.structuredContent.handledBy, 'HERMES');
});

test('HERMES fails closed on changed readback rather than reporting verified truth', async () => {
  let calls = 0;
  const reader = createHermesWorkReader({
    getWork: async () => ({ workId: 'W-X', checkpointId: 'CP-1', state: ++calls === 1 ? 'RECEIVED' : 'COMPLETED' }),
    mayRead: () => true,
  });
  await assert.rejects(() => reader.read({ actor: 'GO', workId: 'W-X' }), /READBACK_MISMATCH/);
});
