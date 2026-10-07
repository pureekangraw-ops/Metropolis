import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesReception, findHermesLostWork } from '../src/agents/hermes/station-reception.mjs';
import { prepareMimirReturn, RETURN_CONFIRMATION } from '../src/agents/mimir/return-desk.mjs';
import { rotateHallData, DATA_LIFECYCLE_STATUS } from '../src/secretary/product-life-cycle.mjs';
import { createPixieReport } from '../src/pixie/report-router.mjs';

test('HERMES reception exposes only existing authorized Work pointers and creates no Work', () => {
  const reception = createHermesReception({
    actor: 'GO',
    works: [
      { workId: 'W1', present: true, state: 'HANDED_OFF', checkpointId: 'CP1', ownerSystem: 'FACTORY', authorizedActions: ['read'] },
      { workId: 'W2', present: false, state: 'UNKNOWN', checkpointId: null, ownerSystem: null, authorizedActions: ['intake'] },
    ],
    observedAt: '2026-10-07T00:00:00Z',
  });
  assert.equal(reception.staff.id, 'HERMES');
  assert.equal(reception.staff.ownsWorkTruth, false);
  assert.equal(reception.intakeDesk.anchor, 'WORK_FLOW');
  assert.equal(reception.intakeDesk.securityVisibleAsNavigation, false);
  assert.deepEqual(reception.intakeDesk.flow.stages, ['INPUT_INFORMATION', 'DRAFT', 'REVIEW']);
  assert.deepEqual(reception.intakeDesk.flow.decisions, ['READY_TO_CREATE', 'READY_TO_RESUME']);
  assert.equal(Object.hasOwn(reception.tabletDesk.pointers[0], 'authorizedActions'), false);
  assert.equal(reception.lostAndFound.createsWork, false);
  assert.deepEqual(reception.lostAndFound.candidates.map(item => item.workId), ['W1']);
  assert.equal(findHermesLostWork(reception, 'W1').checkpointId, 'CP1');
  assert.equal(findHermesLostWork(reception, 'W2'), null);
});

test('MIMIR asks for update and confirmation before organizing return data', () => {
  const pending = prepareMimirReturn({
    workId: 'W1',
    checkpointId: 'CP1',
    evidenceRefs: ['evidence://1'],
    updates: [{ kind: 'NOTE', valueRef: 'note://1' }],
  });
  assert.equal(pending.status, 'CONFIRMATION_REQUIRED');
  assert.equal(pending.confirmationRequired, RETURN_CONFIRMATION);
  assert.equal(pending.authorityChanged, false);

  const confirmed = prepareMimirReturn({
    workId: 'W1',
    checkpointId: 'CP1',
    readback: { status: 'RETURNED' },
    evidenceRefs: ['evidence://1'],
    updates: [{ kind: 'NOTE', valueRef: 'note://1' }],
    confirmation: RETURN_CONFIRMATION,
  });
  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(confirmed.organized.metadata.organizedBy, 'MIMIR');
  assert.equal(confirmed.organized.updates[0].valueRef, 'note://1');
});

test('Secretary Product Life Cycle supersedes previous current data without rewriting truth owner', () => {
  let entries = rotateHallData([], {
    dataId: 'D1', workId: 'W1', checkpointId: 'CP1',
    producer: 'DWARF', kind: 'RESULT', payloadRef: 'artifact://1',
    ownerSystem: 'FACTORY', truthOwner: 'FACTORY',
  });
  entries = rotateHallData(entries, {
    dataId: 'D2', workId: 'W1', checkpointId: 'CP1',
    producer: 'DWARF', kind: 'RESULT', payloadRef: 'artifact://2',
    ownerSystem: 'FACTORY', truthOwner: 'FACTORY',
  });
  assert.equal(entries[0].status, DATA_LIFECYCLE_STATUS.SUPERSEDED);
  assert.equal(entries[0].supersededBy, 'D2');
  assert.equal(entries[1].status, DATA_LIFECYCLE_STATUS.CURRENT);
  assert.equal(entries[1].truthOwner, 'FACTORY');
  assert.equal(entries[1].managedBy, 'SECRETARY');
});

test('PIXIE routes tool result to Secretary then Owner without claiming authority', () => {
  const report = createPixieReport({
    reportId: 'R1',
    workId: 'W1',
    checkpointId: 'CP1',
    ownerSystem: 'FACTORY',
    sourceTool: 'DWARF',
    status: 'VERIFIED',
    result: { ok: true },
    artifactRefs: ['artifact://1'],
    evidenceRefs: ['evidence://1'],
    receiptRefs: ['receipt://1'],
  });
  assert.deepEqual(report.route, { from: 'PIXIE', to: 'SECRETARY', then: 'OWNER', final: 'WORKER' });
  assert.equal(report.authorityTransferred, false);
  assert.equal(report.ownerSystem, 'FACTORY');
});
