import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityRuntime, createMemoryStore, createRailLink, WORK_STATE } from '../src/city-runtime.mjs';
import { createCityService } from '../src/city-entry.mjs';

test('new city map contains the complete new-city surfaces', () => {
  const runtime = createCityRuntime({ sourceSha: 'a'.repeat(40) });
  assert.deepEqual(runtime.map.components, ['METROPOLIS', 'CITY_HALL', 'WORK_SYSTEM', 'POST_OFFICE', 'PIXIE_SERVICE', 'SHOP', 'SPECTRUMSALE', 'THE_TAILOR']);
  assert.equal(runtime.map.stations.includes('FACTORY_STATION'), true);
});

test('Rail Link has exactly two Station endpoints and one trust boundary', () => {
  const link = createRailLink({ railId: 'RAIL-MF', endpoints: [{ stationId: 'METROPOLIS_STATION', systemId: 'METROPOLIS' }, { stationId: 'FACTORY_STATION', systemId: 'FACTORY' }], trustBoundary: 'METROPOLIS_FACTORY' });
  assert.equal(link.endpoints.length, 2);
  assert.equal(link.trustBoundary, 'METROPOLIS_FACTORY');
  assert.throws(() => createRailLink({ railId: 'bad', endpoints: [{ stationId: 'A', systemId: 'A' }], trustBoundary: 'x' }), /EXACTLY_TWO/);
});

test('Work identity remains stable across intake, handoff and return', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore(), idFactory: (() => { let n = 0; return () => `ID-${++n}`; })(), clock: (() => { let n = 0; return () => `2026-10-06T00:00:0${n++}Z`; })() });
  const received = await runtime.intake({ workId: 'WORK-1', ownerSystem: 'FACTORY', requestedBy: 'GO' });
  const handed = await runtime.handoff({ workId: 'WORK-1', checkpointId: received.checkpointId, stationId: 'FACTORY_STATION', operation: 'EXECUTE' });
  const returned = await runtime.returnWork({ workId: 'WORK-1', checkpointId: received.checkpointId, readback: { owner: 'FACTORY' }, evidenceRefs: ['evidence://1'], confirmation: 'CONFIRM_RETURN', verified: true });
  assert.equal(handed.workId, 'WORK-1');
  assert.equal(Object.hasOwn(handed.handoff, 'railId'), false);
  assert.equal(returned.workId, 'WORK-1');
  assert.equal(returned.state, WORK_STATE.RETURNED);
  assert.equal(returned.history.length, 3);
  assert.equal(returned.returnReview.status, 'CONFIRMED');
  assert.equal(returned.dataLifecycle.some(entry => entry.producer === 'MIMIR'), true);
});

test('Work Pass is persisted in the same Work record and is not inferred from requestedBy', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore(), clock: () => '2026-10-07T09:00:00.000Z' });

  const withPass = await runtime.intake({
    workId: 'WORK-WITH-PASS',
    ownerSystem: 'PRISM',
    requestedBy: 'GO',
    workPassActor: 'GO',
  });
  assert.equal(withPass.workPass.kind, 'WORK_PASS');
  assert.equal(withPass.workPass.status, 'ACTIVE');
  assert.equal(withPass.workPass.workId, withPass.workId);
  assert.equal(withPass.workPass.checkpointId, withPass.checkpointId);
  assert.equal(withPass.workPass.actor, 'GO');
  assert.equal(withPass.workPassRef, `work-pass://${withPass.workPass.passId}`);

  const metadataOnly = await runtime.intake({
    workId: 'WORK-METADATA-ONLY',
    ownerSystem: 'PRISM',
    requestedBy: 'GO',
  });
  assert.equal(metadataOnly.requestedBy, 'GO');
  assert.equal(metadataOnly.workPass, null);
  assert.equal(metadataOnly.workPassRef, null);
});

test('cancel keeps Work Pass audit identity but removes operational authority', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore(), clock: () => '2026-10-07T09:01:00.000Z' });
  const created = await runtime.intake({
    workId: 'WORK-CANCEL-PASS',
    ownerSystem: 'PRISM',
    requestedBy: 'GO',
    workPassActor: 'GO',
  });
  const passId = created.workPass.passId;

  const cancelled = await runtime.cancelWork({ workId: created.workId, actor: 'HERMES' });
  assert.equal(cancelled.state, WORK_STATE.CANCELLED);
  assert.equal(cancelled.workPass.passId, passId);
  assert.equal(cancelled.workPass.status, 'CANCELLED');
  assert.equal(cancelled.workPass.cancelledBy, 'HERMES');
});

test('wrong checkpoint never mutates the Work record', async () => {
  const runtime = createCityRuntime();
  const received = await runtime.intake({ workId: 'WORK-2', ownerSystem: 'FACTORY' });
  await assert.rejects(() => runtime.handoff({ workId: 'WORK-2', checkpointId: 'wrong', stationId: 'FACTORY_STATION', operation: 'EXECUTE' }), /CHECKPOINT_MISMATCH/);
  assert.equal((await runtime.getWork('WORK-2')).state, WORK_STATE.RECEIVED);
  assert.equal(received.workId, 'WORK-2');
});

test('Post Office delivers cargo only to the matching open mailbox', async () => {
  const runtime = createCityRuntime({ idFactory: (() => { let n = 0; return () => `MAIL-${++n}`; })() });
  runtime.registerMailbox({ mailboxId: 'MAILBOX-GO', owner: 'GO', receiver: 'GO' });
  const delivered = await runtime.sendCargo({ dataId: 'DATA-1', dataKind: 'EVIDENCE', payloadRef: 'evidence://1', owner: 'FACTORY', sender: 'PIXIE', receiver: 'GO', mailbox: 'MAILBOX-GO' });
  assert.equal(delivered.status, 'DELIVERED');
  assert.equal(delivered.receipt.dataId, 'DATA-1');
});

test('City service exposes health and Work intake without a second Work identity', async () => {
  const runtime = createCityRuntime({ sourceSha: 'b'.repeat(40) });
  const service = createCityService({ runtime });
  const health = await service.fetch(new Request('https://metropolis.example/health'));
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'READY');
  const intake = await service.fetch(new Request('https://metropolis.example/work/intake', { method: 'POST', body: JSON.stringify({ workId: 'WORK-3', ownerSystem: 'FACTORY' }) }));
  assert.equal(intake.status, 201);
  const readback = await service.fetch(new Request('https://metropolis.example/work/WORK-3'));
  assert.equal((await readback.json()).workId, 'WORK-3');
});
