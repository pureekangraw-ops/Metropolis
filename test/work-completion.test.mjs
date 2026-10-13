import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCityRuntime,
  createMemoryStore,
  WORK_STATE,
} from '../src/city-runtime.mjs';
import {
  dryRunCompletionContractMigration,
  evaluateCompletionCriteria,
  inspectCompletionContract,
  normalizeCompletionCriteria,
} from '../src/work-completion.mjs';

const criteria = {
  items: [
    { criterionId: 'result', description: 'The requested result is returned and verified' },
    { criterionId: 'tests', description: 'The contract tests pass' },
  ],
};
const legacySourceSha = 'a'.repeat(40);
const unreviewedSourceSha = 'b'.repeat(40);

test('completion criteria require stable identifiers and descriptions', () => {
  const normalized = normalizeCompletionCriteria(criteria, { allowMissing: false });
  assert.equal(normalized.schema, 'WORK_COMPLETION_CRITERIA_V1');
  assert.equal(normalized.items.length, 2);
  assert.throws(() => normalizeCompletionCriteria(null, { allowMissing: false }), /COMPLETION_CRITERIA_REQUIRED/);
  assert.throws(() => normalizeCompletionCriteria({ items: [{ criterionId: 'x', description: 'one' }, { criterionId: 'x', description: 'two' }] }), /COMPLETION_CRITERION_ID_DUPLICATE/);
});

test('unversioned Work is legacy only with exact verified source provenance', () => {
  const legacy = { workId: 'WORK-OLD', state: 'RECEIVED', sourceSha: legacySourceSha };
  assert.equal(inspectCompletionContract(legacy).reason, 'LEGACY_PROVENANCE_UNVERIFIED');
  assert.equal(inspectCompletionContract(legacy, { legacySourceShas: [legacySourceSha] }).classification, 'LEGACY');
  assert.equal(inspectCompletionContract({
    ...legacy,
    completionCriteria: null,
  }, { legacySourceShas: [legacySourceSha] }).reason, 'COMPLETION_CONTRACT_VERSION_REQUIRED');
  assert.equal(inspectCompletionContract({
    ...legacy,
    completionContractVersion: 'HALL_COMPLETION_V99',
  }, { legacySourceShas: [legacySourceSha] }).reason, 'COMPLETION_CONTRACT_VERSION_UNSUPPORTED');
  assert.equal(inspectCompletionContract({
    ...legacy,
    completionContractVersion: 'HALL_COMPLETION_V1',
  }, { legacySourceShas: [legacySourceSha] }).reason, 'COMPLETION_CRITERIA_REQUIRED');
});

test('legacy completion preserves the pre-v1 lifecycle only for verified revisions', async () => {
  const records = new Map([['work:WORK-LEGACY', {
    kind: 'WORK_RECORD',
    workId: 'WORK-LEGACY',
    checkpointId: 'WORK-LEGACY:CP-01',
    ownerSystem: 'FACTORY',
    state: WORK_STATE.RECEIVED,
    sourceSha: legacySourceSha,
    history: [{ state: WORK_STATE.RECEIVED, at: '2026-10-01T00:00:00.000Z' }],
  }]]);
  let writes = 0;
  const store = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { writes += 1; records.set(key, structuredClone(value)); return value; },
    async list(prefix = '') { return [...records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); },
  };
  const runtime = createCityRuntime({
    store,
    legacySourceShas: [legacySourceSha],
    clock: () => '2026-10-13T01:30:00.000Z',
  });

  const preflight = await runtime.inspectWorkCompletionContract({ workId: 'WORK-LEGACY' });
  assert.equal(preflight.classification, 'LEGACY');
  assert.equal(writes, 0, 'contract preflight is read-only');

  const completed = await runtime.completeWork({ workId: 'WORK-LEGACY' });
  assert.equal(completed.state, WORK_STATE.COMPLETED);
  assert.equal(completed.completionCheck, undefined);
  assert.equal(completed.completion.completedAt, '2026-10-13T01:30:00.000Z');
});

test('unknown or malformed legacy provenance blocks resume and completion without writes', async () => {
  const candidates = [
    { workId: 'WORK-UNKNOWN-SHA', sourceSha: unreviewedSourceSha },
    { workId: 'WORK-MALFORMED', sourceSha: legacySourceSha, completionCriteria: null },
    { workId: 'WORK-UNKNOWN-VERSION', sourceSha: legacySourceSha, completionContractVersion: 'HALL_COMPLETION_V99' },
  ];
  const records = new Map(candidates.map(record => [`work:${record.workId}`, {
    kind: 'WORK_RECORD',
    checkpointId: `${record.workId}:CP-01`,
    ownerSystem: 'FACTORY',
    state: WORK_STATE.RECEIVED,
    history: [],
    ...record,
  }]));
  let writes = 0;
  const store = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { writes += 1; records.set(key, structuredClone(value)); return value; },
    async list(prefix = '') { return [...records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) })); },
  };
  const runtime = createCityRuntime({ store, legacySourceShas: [legacySourceSha] });

  for (const candidate of candidates) {
    const result = await runtime.inspectWorkCompletionContract({ workId: candidate.workId });
    assert.equal(result.classification, 'BLOCKED');
    await assert.rejects(() => runtime.resumeWork({ workId: candidate.workId }), /LEGACY_PROVENANCE_UNVERIFIED|COMPLETION_CONTRACT_VERSION_REQUIRED|COMPLETION_CONTRACT_VERSION_UNSUPPORTED/);
    await assert.rejects(() => runtime.completeWork({ workId: candidate.workId }), /LEGACY_PROVENANCE_UNVERIFIED|COMPLETION_CONTRACT_VERSION_REQUIRED|COMPLETION_CONTRACT_VERSION_UNSUPPORTED/);
  }
  assert.equal(writes, 0, 'blocked read-only preflight must not update Work or signals');
});

test('migration dry-run classifies without writing and leaves unverified sources unresolved', async () => {
  const records = [
    { workId: 'WORK-LEGACY', state: 'RECEIVED', sourceSha: legacySourceSha },
    { workId: 'WORK-UNKNOWN', state: 'RECEIVED', sourceSha: unreviewedSourceSha },
    { workId: 'WORK-V1', state: 'RECEIVED', sourceSha: 'current', completionContractVersion: 'HALL_COMPLETION_V1', completionCriteria: criteria },
  ];
  const result = dryRunCompletionContractMigration(records, { legacySourceShas: [legacySourceSha] });
  assert.equal(result.mode, 'READ_ONLY');
  assert.deepEqual(result.counts, { LEGACY: 1, BLOCKED: 1, V1: 1 });
  assert.equal(result.entries.find(row => row.workId === 'WORK-UNKNOWN').reason, 'LEGACY_PROVENANCE_UNVERIFIED');
});

test('completion check stays open until every criterion is PASS with evidence', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const created = await runtime.intake({
    workId: 'WORK-COMPLETION',
    ownerSystem: 'METROPOLIS',
    intakeInformation: { completionCriteria: criteria },
  });
  const incomplete = await runtime.completeWork({
    workId: created.workId,
    requestedBy: 'LIGHT',
    criteriaResults: [{ criterionId: 'result', status: 'PASS', evidenceRefs: ['test://result'] }],
  });
  assert.equal(incomplete.state, WORK_STATE.RECEIVED);
  assert.equal(incomplete.completionCheck.status, 'INCOMPLETE');

  const notMet = await runtime.completeWork({
    workId: created.workId,
    requestedBy: 'LIGHT',
    criteriaResults: [
      { criterionId: 'result', status: 'PASS', evidenceRefs: ['test://result'] },
      { criterionId: 'tests', status: 'FAIL', evidenceRefs: ['test://failure'] },
    ],
  });
  assert.equal(notMet.state, WORK_STATE.RECEIVED);
  assert.equal(notMet.completionCheck.status, 'NOT_MET');

  const completed = await runtime.completeWork({
    workId: created.workId,
    requestedBy: 'LIGHT',
    criteriaResults: [
      { criterionId: 'result', status: 'PASS', evidenceRefs: ['test://result'] },
      { criterionId: 'tests', status: 'PASS', evidenceRefs: ['test://suite'] },
    ],
  });
  assert.equal(completed.state, WORK_STATE.COMPLETED);
  assert.equal(completed.completionCheck.status, 'PASS');
  assert.deepEqual(evaluateCompletionCriteria(criteria, [
    { criterionId: 'result', status: 'PASS', evidenceRefs: ['test://result'] },
    { criterionId: 'tests', status: 'PASS', evidenceRefs: ['test://suite'] },
  ]).status, 'PASS');
});

test('handoff Work cannot complete until it has a verified return', async () => {
  const runtime = createCityRuntime({ store: createMemoryStore() });
  const created = await runtime.intake({
    workId: 'WORK-NOT-RETURNED',
    ownerSystem: 'FACTORY',
    intakeInformation: { completionCriteria: { items: [{ criterionId: 'result', description: 'The result is returned' }] } },
  });
  await runtime.handoff({
    workId: created.workId,
    checkpointId: created.checkpointId,
    stationId: 'FACTORY_STATION',
    operation: 'BUILD',
  });
  await assert.rejects(() => runtime.completeWork({
    workId: created.workId,
    criteriaResults: [{ criterionId: 'result', status: 'PASS', evidenceRefs: ['test://proof'] }],
  }), /WORK_NOT_RETURNED/);
});

test('verified normal returns bypass review, while declared exceptions need another actor', async () => {
  const runtime = createCityRuntime({
    store: createMemoryStore(),
    stationRuntimes: {
      FACTORY_STATION: {
        async handoff({ workId, checkpointId }) {
          return { accepted: true, verified: true, workId, checkpointId, receiptId: 'receipt-1' };
        },
        async readback({ workId, checkpointId, handoff }) {
          return {
            workId, checkpointId, handoffId: handoff.handoffId,
            verified: true, domainVerified: true,
            evidenceRef: 'factory://proof',
            checkpointRefs: { safeCandidateRef: 'checkpoint://candidate-1' },
          };
        },
      },
    },
  });
  const normal = await runtime.intake({
    workId: 'WORK-NORMAL-RETURN',
    ownerSystem: 'FACTORY',
    intakeInformation: { completionCriteria: criteria },
  });
  await runtime.handoff({
    workId: normal.workId, checkpointId: normal.checkpointId,
    stationId: 'FACTORY_STATION', operation: 'BUILD', actor: 'GO',
  });
  const returned = await runtime.returnWork({
    workId: normal.workId, checkpointId: normal.checkpointId, actor: 'GO',
  });
  assert.equal(returned.state, WORK_STATE.RETURNED);
  assert.equal(returned.stationReturnReview.status, 'AUTO_VERIFIED');
  assert.equal(returned.checkpointRefs.safeCandidateRef, 'checkpoint://candidate-1');

  const exceptional = createCityRuntime({
    store: createMemoryStore(),
    stationRuntimes: {
      FACTORY_STATION: {
        async handoff({ workId, checkpointId }) {
          return { accepted: true, verified: true, workId, checkpointId, receiptId: 'receipt-2' };
        },
        async readback({ workId, checkpointId, handoff }) {
          return {
            workId, checkpointId, handoffId: handoff.handoffId,
            verified: true, domainVerified: true,
            evidenceRef: 'factory://recovery-proof',
            reviewTriggers: ['RECOVERY'],
            checkpointRefs: { errorCaptureRef: 'log://error-1' },
          };
        },
      },
    },
  });
  const work = await exceptional.intake({
    workId: 'WORK-EXCEPTIONAL-RETURN',
    ownerSystem: 'FACTORY',
    intakeInformation: { completionCriteria: criteria },
  });
  await exceptional.handoff({
    workId: work.workId, checkpointId: work.checkpointId,
    stationId: 'FACTORY_STATION', operation: 'REPAIR', actor: 'GO',
  });
  const held = await exceptional.returnWork({
    workId: work.workId, checkpointId: work.checkpointId, actor: 'GO',
  });
  assert.equal(held.state, WORK_STATE.RETURN_REVIEW);
  assert.deepEqual(held.stationReturnReview.reviewTriggers, ['RECOVERY']);
  await assert.rejects(() => exceptional.returnWork({
    workId: work.workId, checkpointId: work.checkpointId,
    actor: 'GO', independentReviewComplete: true,
  }), /INDEPENDENT_REVIEWER_REQUIRED/);
  const reviewed = await exceptional.returnWork({
    workId: work.workId, checkpointId: work.checkpointId,
    actor: 'LIGHT', independentReviewComplete: true,
  });
  assert.equal(reviewed.state, WORK_STATE.RETURNED);
  assert.equal(reviewed.stationReturnReview.status, 'INDEPENDENTLY_REVIEWED');
  assert.equal(reviewed.checkpointRefs.errorCaptureRef, 'log://error-1');
});