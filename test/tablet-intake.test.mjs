import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabletRuntime, TABLET_STANDARD } from '../src/tablet-runtime.mjs';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';
import { createHermesReception } from '../src/agents/hermes/station-reception.mjs';

function memoryR2() {
  const objects = new Map();
  return {
    async put(key, body, options = {}) {
      objects.set(key, { body: String(body), options, etag: 'etag-' + objects.size });
      return { key, etag: 'etag-' + objects.size };
    },
    async get(key) {
      const item = objects.get(key);
      if (!item) return null;
      return {
        etag: item.etag,
        async text() { return item.body; },
      };
    },
    objects,
  };
}

test('Draft Tablet exists before Work ID and lives under the R2 draft namespace', async () => {
  const bucket = memoryR2();
  const runtime = createTabletRuntime({
    bucket,
    sourceSha: 'd'.repeat(40),
    now: () => '2026-10-07T07:20:00Z',
  });

  const saved = await runtime.saveDraft({
    draftId: 'DRAFT-1',
    createdBy: 'GO',
    state: 'DRAFT',
    information: { title: 'New request' },
    inputRefs: ['input://one'],
    ownerSystem: 'FACTORY',
    workId: null,
    checkpointId: null,
  });

  assert.equal(saved.status, 'DRAFT_SAVED');
  assert.equal(saved.verified, true);
  assert.equal(saved.tablet.draftId, 'DRAFT-1');
  assert.equal(saved.tablet.workId, null);
  assert.equal(saved.tablet.checkpointId, null);
  assert.equal(saved.tablet.workCreated, false);
  assert.equal(saved.storageRef, 'r2://factory/metropolis/tablets/drafts/DRAFT-1/tablet-draft.json');
  assert.equal(bucket.objects.has('metropolis/tablets/drafts/DRAFT-1/tablet-draft.json'), true);
});

test('Tablet Standard v1 writes Work/Checkpoint snapshot to R2 and verifies checksum by readback', async () => {
  const bucket = memoryR2();
  const runtime = createTabletRuntime({
    bucket,
    sourceSha: 'a'.repeat(40),
    now: (() => {
      const values = ['2026-10-07T07:00:00Z', '2026-10-07T07:00:01Z'];
      return () => values.shift() || '2026-10-07T07:00:02Z';
    })(),
  });

  const issued = await runtime.issue({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    ownerSystem: 'FACTORY',
    state: 'RECEIVED',
    inputRefs: ['input://brief-1'],
  });

  assert.equal(issued.status, 'ISSUED');
  assert.equal(issued.verified, true);
  assert.equal(issued.tablet.schema, TABLET_STANDARD.schema);
  assert.equal(issued.tablet.version, '1.1.0');
  assert.equal(issued.tablet.tabletId, 'TABLET:WORK-1:CP-1');
  assert.equal(issued.tablet.workId, 'WORK-1');
  assert.equal(issued.tablet.checkpointId, 'CP-1');
  assert.equal(issued.tablet.ownsWorkTruth, false);
  assert.equal(issued.storageRef, 'r2://factory/metropolis/tablets/WORK-1/CP-1/snapshot/tablet.json');
  assert.equal(issued.checksum, issued.readbackChecksum);
  assert.equal(bucket.objects.has('metropolis/tablets/WORK-1/CP-1/snapshot/tablet.json'), true);
});

test('City intake issues Tablet after Work creation and HERMES exposes only the verified receipt', async () => {
  const bucket = memoryR2();
  const tabletRuntime = createTabletRuntime({
    bucket,
    sourceSha: 'b'.repeat(40),
    now: () => '2026-10-07T07:10:00Z',
  });
  const city = createCityRuntime({
    store: createMemoryStore(),
    sourceSha: 'b'.repeat(40),
    tabletRuntime,
    clock: () => '2026-10-07T07:10:00Z',
  });

  const record = await city.intake({
    workId: 'WORK-INTAKE-1',
    checkpointId: 'CP-INTAKE-1',
    ownerSystem: 'FACTORY',
    requestedBy: 'GO',
    inputRefs: ['input://brief'],
  });

  assert.equal(record.state, 'RECEIVED');
  assert.equal(record.tablet.status, 'ISSUED');
  assert.equal(record.tablet.verified, true);
  assert.equal(record.tablet.tablet.workId, record.workId);
  assert.equal(record.tablet.tablet.checkpointId, record.checkpointId);

  const reception = createHermesReception({
    actor: 'GO',
    works: [{
      workId: record.workId,
      present: true,
      state: record.state,
      checkpointId: record.checkpointId,
      ownerSystem: record.ownerSystem,
      updatedAt: record.updatedAt,
      authorizedActions: ['read'],
      tablet: record.tablet,
    }],
    observedAt: '2026-10-07T07:10:00Z',
  });

  const pointer = reception.tabletDesk.pointers[0];
  assert.equal(pointer.tablet.tabletId, 'TABLET:WORK-INTAKE-1:CP-INTAKE-1');
  assert.equal(pointer.tablet.version, '1.1.0');
  assert.equal(pointer.tablet.status, 'ISSUED');
  assert.equal(pointer.tablet.verified, true);
  assert.match(pointer.tablet.storageRef, /^r2:\/\/factory\/metropolis\/tablets\//);
});

test('Tablet storage failure never becomes a verified Tablet receipt or a second Work truth', async () => {
  const bucket = {
    async put() { return { etag: 'etag-write' }; },
    async get() { return null; },
  };
  const tabletRuntime = createTabletRuntime({ bucket, sourceSha: 'c'.repeat(40) });
  const city = createCityRuntime({ tabletRuntime, sourceSha: 'c'.repeat(40) });

  const record = await city.intake({
    workId: 'WORK-FAIL',
    ownerSystem: 'FACTORY',
    requestedBy: 'GO',
  });

  assert.equal(record.workId, 'WORK-FAIL');
  assert.equal(record.tablet.status, 'UNKNOWN');
  assert.equal(record.tablet.verified, false);
  assert.equal(record.tablet.reason, 'TABLET_R2_READBACK_MISSING');
  assert.equal(record.tablet.tablet.ownsWorkTruth, false);
});
