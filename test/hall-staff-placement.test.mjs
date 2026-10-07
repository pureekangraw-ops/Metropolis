import test from 'node:test';
import assert from 'node:assert/strict';
import { createHermesReception, findHermesLostWork } from '../src/agents/hermes/station-reception.mjs';
import { prepareMimirReturn } from '../src/agents/mimir/return-desk.mjs';
import { rotatePixieData, DATA_LIFECYCLE_STATUS } from '../src/pixie/data-lifecycle.mjs';
import { createPixieReport, createPixieStationDiagnostic } from '../src/pixie/report-router.mjs';

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

test('MIMIR organizes a GO-reviewed packet without asking for another update confirmation', () => {
  const organized = prepareMimirReturn({
    workId: 'W1', checkpointId: 'CP1', journeyId: 'J1', readback: { status: 'RETURNED' },
    evidenceRefs: ['evidence://1'], updates: [{ kind: 'NOTE', valueRef: 'note://1' }],
  });
  assert.equal(organized.status, 'ORGANIZED');
  assert.equal(organized.question, null);
  assert.equal(organized.confirmationRequired, null);
  assert.equal(organized.organized.metadata.organizedBy, 'MIMIR');
  assert.equal(organized.organized.metadata.journeyId, 'J1');
  assert.equal(organized.organized.updates[0].valueRef, 'note://1');
});

test('PIXIE Data Life Cycle supersedes previous current data without rewriting truth owner', () => {
  let entries = rotatePixieData([], {
    dataId: 'D1', workId: 'W1', checkpointId: 'CP1',
    producer: 'DWARF', kind: 'RESULT', payloadRef: 'artifact://1',
    ownerSystem: 'FACTORY', truthOwner: 'FACTORY',
  });
  entries = rotatePixieData(entries, {
    dataId: 'D2', workId: 'W1', checkpointId: 'CP1',
    producer: 'DWARF', kind: 'RESULT', payloadRef: 'artifact://2',
    ownerSystem: 'FACTORY', truthOwner: 'FACTORY',
  });
  assert.equal(entries[0].status, DATA_LIFECYCLE_STATUS.SUPERSEDED);
  assert.equal(entries[0].supersededBy, 'D2');
  assert.equal(entries[1].status, DATA_LIFECYCLE_STATUS.CURRENT);
  assert.equal(entries[1].truthOwner, 'FACTORY');
  assert.equal(entries[1].managedBy, 'PIXIE');
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


test('PIXIE Station diagnostic counts returned baggage and reports additions without approval', () => {
  const diagnostic = createPixieStationDiagnostic({
    diagnosticId:'D1', workId:'W1', checkpointId:'CP1', journeyId:'J1', stationId:'FACTORY_STATION',
    before:{artifactRefs:['artifact://old']},
    after:{artifactRefs:['artifact://old','artifact://new'],evidenceRefs:['evidence://1'],receiptRefs:['receipt://1']},
  });
  assert.equal(diagnostic.status,'CHECKED');
  assert.equal(diagnostic.counts.artifactRefs,2);
  assert.deepEqual(diagnostic.added.artifactRefs,['artifact://new']);
  assert.equal(diagnostic.mayApprove,false);
});
