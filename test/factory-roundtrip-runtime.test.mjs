import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityRuntime, WORK_STATE } from '../src/city-runtime.mjs';
import { createFactoryStationRuntime } from '../src/factory-station-runtime.mjs';

const SOURCE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('Factory round trip preserves Work/Checkpoint and stays UNKNOWN until DWARF domain return is verified', async () => {
  let receivedPayload = null;
  let domainVerified = false;
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    if (target.endsWith('/health')) {
      return Response.json({
        status: 'READY',
        storage: { status: 'READY' },
        transport: { status: 'READY' },
        sourceSha: SOURCE_SHA,
      });
    }
    if (target.endsWith('/station/receive')) {
      assert.equal(init.method, 'POST');
      assert.ok(init.headers['x-metropolis-factory-signature']);
      receivedPayload = JSON.parse(init.body);
      return Response.json({ receipt: { receiptId: 'receipt-1' } }, { status: 200 });
    }
    if (target.endsWith('/station/readback/receipt-1')) {
      assert.ok(init.headers['x-metropolis-factory-signature']);
      return Response.json({
        receiptId: 'receipt-1',
        workId: receivedPayload.workId,
        checkpointId: receivedPayload.checkpointId,
        sourceSha: receivedPayload.expectedSourceSha,
        stationId: 'FACTORY-STATION',
        boundaryVerified: true,
        domainVerified,
        evidenceRef: 'factory-station://receipt-1',
        result: domainVerified ? { workId: receivedPayload.workId, checkpointId: receivedPayload.checkpointId } : null,
      });
    }
    throw new Error('unexpected fetch ' + target);
  };

  const factory = createFactoryStationRuntime({
    baseUrl: 'https://factory.example',
    sharedSecret: 'secret',
    fetchImpl,
  });
  const city = createCityRuntime({
    idFactory: () => 'handoff-1',
    stationRuntimes: { FACTORY_STATION: factory },
  });

  await city.intake({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    ownerSystem: 'CITY_HALL',
    requestedBy: 'GO',
  });

  const handed = await city.handoff({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    stationId: 'FACTORY_STATION',
    operation: 'FACTORY_HANDOFF',
    actor: 'GO',
    payload: { intent: 'BUILD_AND_RETURN', inputRefs: ['artifact://input'] },
  });

  assert.equal(handed.state, WORK_STATE.HANDED_OFF);
  assert.equal(handed.workId, 'WORK-1');
  assert.equal(handed.checkpointId, 'CP-1');
  assert.equal(handed.handoff.external.verified, true);
  assert.equal(handed.handoff.external.sourceSha, SOURCE_SHA);
  assert.equal(receivedPayload.expectedSourceSha, SOURCE_SHA);
  assert.equal(receivedPayload.workId, 'WORK-1');
  assert.equal(receivedPayload.checkpointId, 'CP-1');

  const premature = await city.returnWork({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    actor: 'MIMIR',
    readback: { claimed: true },
    evidenceRefs: [],
    verified: false,
  });
  assert.equal(premature.state, WORK_STATE.UNKNOWN);
  assert.equal(premature.return.verified, false);

  domainVerified = true;
  const returned = await city.returnWork({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    actor: 'MIMIR',
    readback: { claimed: false },
    evidenceRefs: [],
    verified: false,
  });
  assert.equal(returned.state, WORK_STATE.RETURNED);
  assert.equal(returned.return.verified, true);
  assert.equal(returned.return.evidenceRefs.includes('factory-station://receipt-1'), true);
  assert.equal(returned.return.readback.domainVerified, true);
  assert.equal(returned.workId, 'WORK-1');
  assert.equal(returned.checkpointId, 'CP-1');
});
