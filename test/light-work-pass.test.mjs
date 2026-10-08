import test from 'node:test';
import assert from 'node:assert/strict';
import { createMetropolisMcp } from '../src/shared-mcp.mjs';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';
import { createWorkPass, inspectWorkPass, workPassAllowsHandoff } from '../src/work-pass.mjs';

const origin = 'https://city.example';
const auth = async request => ({
  actor: request.headers.get('authorization') === 'Bearer light' ? 'LIGHT'
    : request.headers.get('authorization') === 'Bearer go' ? 'GO' : null,
});

async function call(server, name, args, token = 'light') {
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
}

test('LIGHT Work Pass is separate from GO and never grants cross-actor authority', () => {
  const pass = createWorkPass({ workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'LIGHT' });
  assert.equal(pass.actor, 'LIGHT');
  assert.match(pass.passId, /:LIGHT$/);
  assert.equal(inspectWorkPass(pass, { workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'LIGHT' }).valid, true);
  assert.equal(inspectWorkPass(pass, { workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'GO' }).valid, false);
  assert.equal(workPassAllowsHandoff(pass, {
    workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'LIGHT', stationId: 'FACTORY_STATION',
  }), true);
  assert.equal(workPassAllowsHandoff(pass, {
    workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'GO', stationId: 'FACTORY_STATION',
  }), false);
  assert.throws(() => createWorkPass({ workId: 'W-LIGHT', checkpointId: 'CP-01', actor: 'STRANGER' }), /WORK_PASS_ACTOR_NOT_ALLOWED/);
});

test('authenticated LIGHT creates a Work via HERMES and GO cannot read it', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const server = createMetropolisMcp({
    runtime, authenticate: auth, grants: [], sourceSha: 'light-test', version: '1.0.0',
    allowedOrigins: [origin],
  });

  const input = await call(server, 'metropolis_reception', {
    action: 'input_information',
    payload: { information: { title: 'LIGHT owner Work' }, ownerSystem: 'FACTORY' },
  });
  assert.equal(input.isError, false);
  const draftId = input.structuredContent.result.draftId;
  assert.match(draftId, /^DRAFT-/);
  for (const action of ['review', 'ready_to_create']) {
    const reply = await call(server, 'metropolis_reception', { action, draftId, payload: {} });
    assert.equal(reply.isError, false);
  }
  const created = await call(server, 'metropolis_reception', {
    action: 'create_work', draftId, payload: {},
  });
  assert.equal(created.isError, false);
  const work = created.structuredContent.result.work;
  assert.equal(work.workPass.actor, 'LIGHT');
  assert.equal(work.workPass.workId, work.workId);
  assert.equal(work.workPass.checkpointId, work.checkpointId);

  const ownRead = await call(server, 'metropolis_work', {
    action: 'read', workId: work.workId, payload: {},
  });
  assert.equal(ownRead.isError, false);

  const otherRead = await call(server, 'metropolis_work', {
    action: 'read', workId: work.workId, payload: {},
  }, 'go');
  assert.equal(otherRead.isError, true);
  assert.equal(otherRead.structuredContent.reason, 'NO_GRANT');
});
