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
  assert.deepEqual(current.tools.map(t => t.name), ['metropolis_identity', 'metropolis_arrive', 'metropolis_reception', 'metropolis_work']);
  assert.equal(current.reception.intakeDesk.anchor, 'WORK_FLOW');
  assert.equal(current.reception.intakeDesk.securityVisibleAsNavigation, false);
  assert.equal(current.refresh.transportNotificationSupported, false);
});

test('tool descriptors expose strict action-discriminated input schemas', async () => {
  const listed = await (await rpc(service(), 'tools/list', {}, 'invalid')).json();
  const reception = listed.result.tools.find(tool => tool.name === 'metropolis_reception');
  const work = listed.result.tools.find(tool => tool.name === 'metropolis_work');

  assert.equal(reception.inputSchema.type, 'object');
  assert.equal(reception.inputSchema.oneOf.length, 8);
  assert.equal(work.inputSchema.type, 'object');
  assert.equal(work.inputSchema.oneOf.length, 3);

  const review = reception.inputSchema.oneOf.find(schema => schema.properties.action.const === 'review');
  assert.deepEqual(review.required, ['action', 'draftId']);
  assert.equal(review.additionalProperties, false);
  assert.equal(review.properties.payload.additionalProperties, false);

  const cancel = reception.inputSchema.oneOf.find(schema => schema.properties.action.const === 'cancel');
  assert.equal(Object.hasOwn(cancel.properties, 'draftId'), false);
  assert.deepEqual(cancel.required, ['action', 'payload']);
  assert.deepEqual(cancel.properties.payload.required, ['targetKind', 'targetId']);

  const read = work.inputSchema.oneOf.find(schema => schema.properties.action.const === 'read');
  assert.deepEqual(read.required, ['action', 'workId']);
  assert.equal(read.properties.payload.additionalProperties, false);

  const handoff = work.inputSchema.oneOf.find(schema => schema.properties.action.const === 'handoff');
  assert.deepEqual(handoff.required, ['action', 'workId', 'payload']);
  assert.deepEqual(handoff.properties.payload.required, ['stationId', 'operation']);
});

test('runtime rejects arguments that violate the action-specific tool schema', async () => {
  const server = service();

  const badReview = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'review', payload: {} },
  })).json()).result;
  assert.equal(badReview.isError, true);
  assert.equal(badReview.structuredContent.reason, 'INVALID_ARGUMENT');

  const badCancel = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: {
      action: 'cancel',
      draftId: 'DRAFT-SHOULD-NOT-BE-HERE',
      payload: { targetKind: 'DRAFT', targetId: 'DRAFT-1' },
    },
  })).json()).result;
  assert.equal(badCancel.isError, true);
  assert.equal(badCancel.structuredContent.reason, 'INVALID_ARGUMENT');

  const badRead = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId: 'W1', payload: { stationId: 'FACTORY_STATION' } },
  })).json()).result;
  assert.equal(badRead.isError, true);
  assert.equal(badRead.structuredContent.reason, 'INVALID_ARGUMENT');

  const badHandoff = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'handoff', workId: 'W1', payload: { stationId: 'FACTORY_STATION' } },
  })).json()).result;
  assert.equal(badHandoff.isError, true);
  assert.equal(badHandoff.structuredContent.reason, 'INVALID_ARGUMENT');

  const badReturn = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'return', workId: 'W1', payload: { evidenceRefs: [], unexpected: true } },
  })).json()).result;
  assert.equal(badReturn.isError, true);
  assert.equal(badReturn.structuredContent.reason, 'INVALID_ARGUMENT');
});
test('arrival refreshes schema and shows only authorized current Work pointers without creating Work', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', checkpointId: 'CP-LIVE', ownerSystem: 'FACTORY', requestedBy: 'GO', inputRefs: ['private://payload'] });
  const server = service('one', runtime, [
    { actor: 'GO', action: 'read', workId: 'W1' },
    { actor: 'GO', action: 'read', workId: 'W2' },
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
  assert.deepEqual(pending.authorizedActions, ['read']);
  assert.equal(pending.present, false);
  assert.equal(pending.state, 'UNKNOWN');
  assert.equal(await runtime.getWork('W2'), undefined);

  const light = await arrive(server, 'light');
  assert.deepEqual(light.current.works, []);
});

test('HERMES creates Work ID only after INPUT → DRAFT → REVIEW → READY TO CREATE', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const server = service('new', runtime, []);

  const input = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: {
      action: 'input_information',
      payload: {
        information: { title: 'First real work', summary: 'Create after review' },
        ownerSystem: 'FACTORY',
      },
    },
  })).json()).result;
  assert.equal(input.isError, false);
  const draftId = input.structuredContent.result.draftId;
  assert.match(draftId, /^DRAFT-/);
  assert.equal(input.structuredContent.result.workId, null);

  const review = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'review', draftId, payload: {} },
  })).json()).result;
  assert.equal(review.structuredContent.result.state, 'REVIEW');
  assert.equal(review.structuredContent.result.review.status, 'READY_FOR_DECISION');

  const ready = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'ready_to_create', draftId, payload: {} },
  })).json()).result;
  assert.equal(ready.structuredContent.result.state, 'READY_TO_CREATE');

  const created = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'create_work', draftId, payload: {} },
  })).json()).result;
  assert.equal(created.isError, false);
  assert.match(created.structuredContent.result.workId, /^WORK-/);
  assert.match(created.structuredContent.result.checkpointId, /:CP-01$/);
  assert.equal(created.structuredContent.result.work.intakeDraftId, draftId);
  assert.equal(created.structuredContent.result.work.workPass.kind, 'WORK_PASS');
  assert.equal(created.structuredContent.result.work.workPass.version, 'WORK_PASS_V1');
  assert.equal(created.structuredContent.result.work.workPass.actor, 'GO');
  assert.equal(created.structuredContent.result.work.workPass.status, 'ACTIVE');
  assert.equal(created.structuredContent.result.work.workPass.workId, created.structuredContent.result.workId);
  assert.equal(created.structuredContent.result.work.workPass.checkpointId, created.structuredContent.result.checkpointId);
  assert.equal(created.structuredContent.result.work.workPassRef, `work-pass://${created.structuredContent.result.work.workPass.passId}`);
  assert.equal(created.structuredContent.result.go, true);
});

test('HERMES-created GO Work gets persisted Work Pass access without manual grants', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const server = service('derived', runtime, []);

  const input = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: {
      action: 'input_information',
      payload: { information: { title: 'Derived access work' }, ownerSystem: 'PRISM' },
    },
  })).json()).result;
  const draftId = input.structuredContent.result.draftId;
  await rpc(server, 'tools/call', { name: 'metropolis_reception', arguments: { action: 'review', draftId, payload: {} } });
  await rpc(server, 'tools/call', { name: 'metropolis_reception', arguments: { action: 'ready_to_create', draftId, payload: {} } });
  const created = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'create_work', draftId, payload: {} },
  })).json()).result;
  const workId = created.structuredContent.result.workId;

  const manifest = await arrive(server);
  const pointer = manifest.current.works.find(work => work.workId === workId);
  assert.ok(pointer);
  assert.equal(pointer.accessSource, 'PERSISTED_WORK_PASS');
  assert.equal(pointer.workPassRef, created.structuredContent.result.work.workPassRef);
  assert.deepEqual(pointer.authorizedActions, ['read', 'handoff', 'return']);

  const read = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId, payload: {} },
  })).json()).result;
  assert.equal(read.isError, false);
  assert.equal(read.structuredContent.record.workId, workId);

  const deniedDestination = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'handoff', workId, payload: { stationId: 'OTHER_STATION', operation: 'BUILD' } },
  })).json()).result;
  assert.equal(deniedDestination.isError, true);
  assert.equal(deniedDestination.structuredContent.reason, 'DESTINATION_NOT_GRANTED');

  const lightRead = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId, payload: {} },
  }, 'light')).json()).result;
  assert.equal(lightRead.isError, true);
  assert.equal(lightRead.structuredContent.reason, 'NO_GRANT');
});


test('requestedBy metadata alone never creates Work authority', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({
    workId: 'WORK-NO-PASS',
    ownerSystem: 'PRISM',
    requestedBy: 'GO',
  });
  const record = await runtime.getWork('WORK-NO-PASS');
  assert.equal(record.requestedBy, 'GO');
  assert.equal(record.workPass, null);
  assert.equal(record.workPassRef, null);

  const server = service('no-pass', runtime, []);
  const reply = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId: 'WORK-NO-PASS' },
  })).json()).result;
  assert.equal(reply.isError, true);
  assert.equal(reply.structuredContent.reason, 'NO_GRANT');
});

test('Work Pass preserves identity on handoff and caller cannot replace its pass reference', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const created = await runtime.intake({
    workId: 'WORK-PASS-HANDOFF',
    checkpointId: 'WORK-PASS-HANDOFF:CP-01',
    ownerSystem: 'PRISM',
    requestedBy: 'GO',
    workPassActor: 'GO',
  });
  const server = service('pass-handoff', runtime, []);
  const spoofed = 'work-pass://ATTACKER';

  const reply = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: {
      action: 'handoff',
      workId: created.workId,
      payload: {
        stationId: 'FACTORY_STATION',
        operation: 'CODE',
        payload: {
          workId: 'WORK-OTHER',
          checkpointId: 'WORK-OTHER:CP-99',
          workPassRef: spoofed,
        },
      },
    },
  })).json()).result;

  assert.equal(reply.isError, false);
  assert.equal(reply.structuredContent.record.workId, created.workId);
  assert.equal(reply.structuredContent.record.checkpointId, created.checkpointId);
  assert.equal(reply.structuredContent.record.handoff.workPassRef, created.workPassRef);
  assert.equal(reply.structuredContent.record.handoff.payload.workPassRef, created.workPassRef);
  assert.equal(reply.structuredContent.record.handoff.payload.workPass.passId, created.workPass.passId);
  assert.equal(reply.structuredContent.record.handoff.payload.workPass.workId, created.workId);
  assert.equal(reply.structuredContent.record.handoff.payload.workPass.checkpointId, created.checkpointId);
  assert.notEqual(reply.structuredContent.record.handoff.payload.workPassRef, spoofed);
});

test('CANCEL makes persisted Work Pass read-only and blocks operational actions', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const server = service('cancel-pass', runtime, []);

  const input = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: {
      action: 'input_information',
      payload: { information: { title: 'Cancelable pass work' }, ownerSystem: 'PRISM' },
    },
  })).json()).result;
  const draftId = input.structuredContent.result.draftId;
  await rpc(server, 'tools/call', { name: 'metropolis_reception', arguments: { action: 'review', draftId, payload: {} } });
  await rpc(server, 'tools/call', { name: 'metropolis_reception', arguments: { action: 'ready_to_create', draftId, payload: {} } });
  const created = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'create_work', draftId, payload: {} },
  })).json()).result;
  const workId = created.structuredContent.result.workId;

  const cancelled = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'cancel', payload: { targetKind: 'WORK', targetId: workId } },
  })).json()).result;
  assert.equal(cancelled.isError, false);
  assert.equal(cancelled.structuredContent.result.work.workPass.status, 'CANCELLED');

  const read = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId },
  })).json()).result;
  assert.equal(read.isError, false);

  const handoff = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'handoff', workId, payload: { stationId: 'FACTORY_STATION', operation: 'CODE' } },
  })).json()).result;
  assert.equal(handoff.isError, true);
  assert.equal(handoff.structuredContent.reason, 'NO_GRANT');

  const returned = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'return', workId, payload: {} },
  })).json()).result;
  assert.equal(returned.isError, true);
  assert.equal(returned.structuredContent.reason, 'NO_GRANT');
});

test('READY TO RESUME gates SEARCH then resumes the existing Work ID and checkpoint', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({
    workId: 'WORK-EXISTING',
    checkpointId: 'WORK-EXISTING:CP-07',
    ownerSystem: 'FACTORY',
    requestedBy: 'GO',
    intakeDraftId: 'DRAFT-OLD',
    intakeInformation: { title: 'Existing Work', summary: 'Resume me' },
  });
  const server = service('one', runtime, []);

  const input = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: {
      action: 'input_information',
      payload: { information: { title: 'Continue Existing Work' } },
    },
  })).json()).result;
  const draftId = input.structuredContent.result.draftId;

  await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'review', draftId, payload: {} },
  });
  await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'ready_to_resume', draftId, payload: {} },
  });

  const search = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'search_work', draftId, payload: { query: 'Existing Work' } },
  })).json()).result;
  assert.equal(search.isError, false);
  assert.equal(search.structuredContent.result.matches[0].workId, 'WORK-EXISTING');

  const resume = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'resume_work', draftId, payload: { workId: 'WORK-EXISTING' } },
  })).json()).result;
  assert.equal(resume.isError, false);
  assert.equal(resume.structuredContent.result.status, 'WORK_RESUMED');
  assert.equal(resume.structuredContent.result.workId, 'WORK-EXISTING');
  assert.equal(resume.structuredContent.result.checkpointId, 'WORK-EXISTING:CP-07');
  assert.equal(resume.structuredContent.result.workTruthChanged, false);
  assert.equal(resume.structuredContent.result.go, true);
});
test('CANCEL selects its target after the command and can cancel Draft or Work', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  await runtime.intake({ workId: 'WORK-CANCEL-ME', ownerSystem: 'FACTORY', requestedBy: 'GO' });
  const server = service('one', runtime, []);

  const input = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'input_information', payload: { information: { title: 'Temporary draft' } } },
  })).json()).result;
  const draftId = input.structuredContent.result.draftId;

  const cancelledDraft = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'cancel', payload: { targetKind: 'DRAFT', targetId: draftId } },
  })).json()).result;
  assert.equal(cancelledDraft.isError, false);
  assert.equal(cancelledDraft.structuredContent.result.targetKind, 'DRAFT');
  assert.equal(cancelledDraft.structuredContent.result.draft.state, 'CANCELLED');

  const cancelledWork = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_reception',
    arguments: { action: 'cancel', payload: { targetKind: 'WORK', targetId: 'WORK-CANCEL-ME' } },
  })).json()).result;
  assert.equal(cancelledWork.isError, false);
  assert.equal(cancelledWork.structuredContent.result.targetKind, 'WORK');
  assert.equal(cancelledWork.structuredContent.result.work.state, 'CANCELLED');
});

test('LIGHT cannot reuse GO grant or self-declare GO identity', async () => {
  const runtime = createCityRuntime();
  await runtime.intake({ workId: 'W1', ownerSystem: 'FACTORY' });
  const server = service('one', runtime);
  await arrive(server, 'light');

  const spoofed = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId: 'W1', payload: { actor: 'GO' } },
  }, 'light')).json()).result;
  assert.equal(spoofed.isError, true);
  assert.equal(spoofed.structuredContent.reason, 'INVALID_ARGUMENT');

  const denied = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'read', workId: 'W1' },
  }, 'light')).json()).result;
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.reason, 'NO_GRANT');
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

  const spoofed = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'return', workId: 'W1', payload: { verified: true, evidenceRefs: ['evidence://one'] } },
  })).json()).result;
  assert.equal(spoofed.isError, true);
  assert.equal(spoofed.structuredContent.reason, 'INVALID_ARGUMENT');

  const review = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'return', workId: 'W1', payload: { evidenceRefs: ['evidence://one'] } },
  })).json()).result;
  assert.equal(review.isError, false);
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

  const denied = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'handoff', workId: 'W1', payload: { stationId: 'OTHER_STATION', operation: 'CODE' } },
  })).json()).result;
  assert.equal(denied.structuredContent.reason, 'DESTINATION_NOT_GRANTED');

  const spoofed = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: {
      action: 'handoff',
      workId: 'W1',
      payload: { stationId: 'FACTORY_STATION', operation: 'CODE', workId: 'W2', actor: 'LIGHT' },
    },
  })).json()).result;
  assert.equal(spoofed.isError, true);
  assert.equal(spoofed.structuredContent.reason, 'INVALID_ARGUMENT');

  const accepted = (await (await rpc(server, 'tools/call', {
    name: 'metropolis_work',
    arguments: { action: 'handoff', workId: 'W1', payload: { stationId: 'FACTORY_STATION', operation: 'CODE' } },
  })).json()).result;
  assert.equal(accepted.isError, false);
  assert.equal(accepted.structuredContent.record.workId, 'W1');
  assert.equal(accepted.structuredContent.record.handoff.actor, 'GO');
  assert.equal(Object.hasOwn(accepted.structuredContent.record.handoff, 'railId'), false);
});
