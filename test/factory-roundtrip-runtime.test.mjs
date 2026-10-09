import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityRuntime, WORK_STATE } from '../src/city-runtime.mjs';
import { createFactoryStationRuntime } from '../src/factory-station-runtime.mjs';

const SOURCE_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('Factory round trip preserves Work/Checkpoint and stays UNKNOWN until DWARF domain return is verified', async () => {
  let receivedPayload = null;
  let preflightCalls = 0;
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
    if (target.endsWith('/station/preflight')) {
      preflightCalls++;
      assert.equal(init.method, 'POST');
      assert.ok(init.headers['x-metropolis-factory-signature']);
      const payload = JSON.parse(init.body);
      return Response.json({
        allowed: true, status: 'READY', workId: payload.workId,
        checkpointId: payload.checkpointId, workPassRef: payload.workPassRef,
        actingActor: payload.actingActor, operation: payload.operation,
        sourceSha: payload.expectedSourceSha,
        validationScope: 'FACTORY_BOUNDARY_PREFLIGHT',
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
        workPassRef: receivedPayload.workPassRef,
        actingActor: receivedPayload.actingActor,
        sourceSha: receivedPayload.expectedSourceSha,
        stationId: 'FACTORY-STATION',
        boundaryVerified: true,
        domainVerified,
        evidenceRef: 'factory-station://receipt-1',
        result: domainVerified ? { workId: receivedPayload.workId, checkpointId: receivedPayload.checkpointId, workPassRef: receivedPayload.workPassRef } : null,
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
    workPassActor: 'GO',
  });

  const handed = await city.handoff({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    stationId: 'FACTORY_STATION',
    operation: 'FACTORY_HANDOFF',
    actor: 'GO',
    payload: { intent: 'BUILD_AND_RETURN', inputRefs: ['artifact://input'] },
  });

  assert.equal(preflightCalls, 1);
  assert.equal(handed.state, WORK_STATE.HANDED_OFF);
  assert.equal(handed.workId, 'WORK-1');
  assert.equal(handed.checkpointId, 'CP-1');
  assert.equal(handed.handoff.external.verified, true);
  assert.equal(handed.handoff.external.sourceSha, SOURCE_SHA);
  assert.equal(receivedPayload.expectedSourceSha, SOURCE_SHA);
  assert.equal(receivedPayload.workId, 'WORK-1');
  assert.equal(receivedPayload.checkpointId, 'CP-1');
  assert.equal(receivedPayload.actingActor, 'GO');
  assert.equal(receivedPayload.operation, 'FACTORY_HANDOFF');
  assert.equal(receivedPayload.cityAuthorization, null);
  assert.equal(receivedPayload.workPass.workId, 'WORK-1');
  assert.equal(receivedPayload.workPass.checkpointId, 'CP-1');
  assert.equal(receivedPayload.workPassRef, `work-pass://${receivedPayload.workPass.passId}`);

  const premature = await city.returnWork({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    actor: 'GO',
    readback: { claimed: true },
    evidenceRefs: [],
  });
  assert.equal(premature.state, WORK_STATE.RETURN_REVIEW);
  assert.equal(premature.stationReturnReview.status, 'GO_REVIEW_REQUIRED');
  assert.equal(premature.stationReturnReview.verified, false);
  const firstOutAt = premature.journeys[0].outAt;

  domainVerified = true;
  const refreshed = await city.returnWork({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    actor: 'GO',
  });
  assert.equal(refreshed.state, WORK_STATE.RETURN_REVIEW);
  assert.equal(refreshed.stationReturnReview.verified, true);
  assert.equal(refreshed.journeys[0].outAt, firstOutAt);

  const returned = await city.returnWork({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    actor: 'GO',
    stationReviewed: true,
    updates: [],
  });
  assert.equal(returned.state, WORK_STATE.RETURNED);
  assert.equal(returned.return.verified, true);
  assert.equal(returned.return.evidenceRefs.includes('factory-station://receipt-1'), true);
  assert.equal(returned.return.readback.domainVerified, true);
  assert.equal(returned.return.postal.status, 'DELIVERED');
  assert.equal(returned.return.postal.route.originBranch, 'FACTORY_POST_OFFICE');
  assert.equal(returned.return.postal.route.destinationBranch, 'CENTRAL_POST_OFFICE');
  assert.equal(returned.dataLifecycle.some(entry => entry.producer === 'POST_OFFICE' && entry.kind === 'DELIVERY_RECEIPT'), true);
  assert.equal(returned.workId, 'WORK-1');
  assert.equal(returned.checkpointId, 'CP-1');
});
