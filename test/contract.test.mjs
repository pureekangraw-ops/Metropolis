import test from 'node:test';
import assert from 'node:assert/strict';
import {
  METROPOLIS_ROLES,
  createOathEnvelope,
  createRail,
  createStation,
  createWorkIdentity,
  classifyReconciliation,
} from '../src/contract.mjs';

test('Metropolis separates City Hall from the wider connection environment', () => {
  assert.equal(METROPOLIS_ROLES.METROPOLIS, 'connection_environment');
  assert.equal(METROPOLIS_ROLES.CITY_HALL, 'intake_return_data');
  assert.notEqual(METROPOLIS_ROLES.METROPOLIS, METROPOLIS_ROLES.CITY_HALL);
});

test('Work identity carries continuity without copying owner operational state', () => {
  const identity = createWorkIdentity({ workId: 'WORK-1', ownerSystem: 'FACTORY', checkpointId: 'CP-1' });
  assert.deepEqual(identity, {
    kind: 'WORK_IDENTITY',
    contractVersion: '0.1.0',
    workId: 'WORK-1',
    ownerSystem: 'FACTORY',
    checkpointId: 'CP-1',
    ownerRef: null,
    handoffId: null,
  });
  assert.equal(Object.hasOwn(identity, 'currentState'), false);
});

test('one Station owns exactly one Rail and its credential boundary', () => {
  const station = createStation({
    stationId: 'STATION-FACTORY',
    railId: 'RAIL-FACTORY',
    ownerSystem: 'FACTORY',
    credentialRef: 'credential://factory/main',
  });
  const rail = createRail({
    railId: station.railId,
    stationId: station.stationId,
    ownerSystem: station.ownerSystem,
  });
  assert.equal(station.kind, 'STATION');
  assert.equal(rail.kind, 'RAIL');
  assert.equal(station.railId, rail.railId);
  assert.equal(rail.stationId, station.stationId);
  assert.equal(Object.hasOwn(rail, 'credentialRef'), false);
});

test('OATH transports over the Station/Rail pair without selecting authority', () => {
  const oath = createOathEnvelope({
    oathId: 'OATH-1',
    workId: 'WORK-1',
    stationId: 'STATION-FACTORY',
    railId: 'RAIL-FACTORY',
    operation: 'READ_REALITY',
    payload: {},
    requestedAt: '2026-10-05T00:00:00Z',
  });
  assert.equal(oath.kind, 'OATH');
  assert.equal(oath.stationId, 'STATION-FACTORY');
  assert.equal(oath.railId, 'RAIL-FACTORY');
  assert.equal(Object.hasOwn(oath, 'authority'), false);
});

test('Station rejects raw credentials', () => {
  assert.throws(
    () => createStation({ stationId: 'S', railId: 'R', ownerSystem: 'FACTORY', credentialRef: 'secret-value' }),
    /credentialRef_MUST_BE_REFERENCE/,
  );
});

test('Reconciliation reports without selecting a winner', () => {
  assert.deepEqual(
    classifyReconciliation({ expectedOwnerSystem: 'FACTORY', observedOwnerSystem: 'FACTORY', expectedRevision: 7, observedRevision: 7, observedAt: '2026-10-05T00:00:00Z' }),
    { status: 'MATCH', reason: 'OWNER_READBACK_MATCH' },
  );
  assert.deepEqual(
    classifyReconciliation({ expectedOwnerSystem: 'FACTORY', observedOwnerSystem: 'FACTORY', expectedRevision: 7, observedRevision: 8, observedAt: '2026-10-05T00:00:00Z' }),
    { status: 'DRIFT', reason: 'OWNER_REVISION_CHANGED' },
  );
  assert.deepEqual(
    classifyReconciliation({ expectedOwnerSystem: 'FACTORY', observedOwnerSystem: 'PRISM', expectedRevision: 7, observedRevision: 7, observedAt: '2026-10-05T00:00:00Z' }),
    { status: 'CONFLICT', reason: 'OWNER_SYSTEM_MISMATCH' },
  );
  assert.deepEqual(
    classifyReconciliation({ expectedOwnerSystem: 'FACTORY', observedOwnerSystem: 'FACTORY' }),
    { status: 'UNKNOWN', reason: 'OWNER_READBACK_INCOMPLETE' },
  );
});
