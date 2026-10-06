import { createStation, createRail } from '../src/contract.mjs';
import { createAuthorityBoundary } from '../src/authority.mjs';
import { createConnectionEngine } from '../src/rail-network.mjs';
import { createFactoryRailAdapter } from '../src/stations/factory.mjs';

const baseUrl = process.env.FACTORY_RUNTIME_URL || 'https://factory-district.pureekangraw.workers.dev';
const workId = process.env.LIVE_E2E_WORK_ID;
const checkpointId = process.env.LIVE_E2E_CHECKPOINT_ID;
const expectedSourceSha = process.env.FACTORY_SOURCE_SHA;
if (!workId || !checkpointId || !expectedSourceSha) throw new Error('LIVE_E2E_WORK_ID, LIVE_E2E_CHECKPOINT_ID and FACTORY_SOURCE_SHA are required; reuse existing Work identity');
const station = createStation({ stationId: 'FACTORY_STATION', railId: 'RAIL_FACTORY', ownerSystem: 'FACTORY', credentialRef: 'credential://factory/live' });
const rail = createRail({ stationId: station.stationId, railId: station.railId, ownerSystem: station.ownerSystem });
const adapter = createFactoryRailAdapter({ baseUrl });
const engine = createConnectionEngine({
  idFactory: () => `TRANSPORT-${Date.now()}`,
  authorizer: createAuthorityBoundary([{ actor: 'GO', stationId: station.stationId, operation: 'FACTORY_HANDOFF', workId }]),
});
engine.registerStation({ station, rail, adapter });

const stationSnapshot = await engine.inspectStation(station.stationId);
const result = await engine.travel({
  actor: 'GO',
  workId,
  stationId: station.stationId,
  operation: 'FACTORY_HANDOFF',
  payload: {
    workId,
    checkpointId,
    expectedSourceSha,
    source: { stationId: 'METROPOLIS-STATION', system: 'METROPOLIS' },
    target: { stationId: 'FACTORY-STATION', system: 'FACTORY', component: 'FACTORY_HALL' },
    ownerDomain: 'CODE',
    intent: 'LIVE_E2E_BOUNDARY_HANDOFF',
    scope: ['EXECUTE:CODE'],
    inputRefs: [],
  },
});

const evidence = {
  workId,
  checkpointId,
  expectedSourceSha,
  stationStatus: stationSnapshot.status,
  stationIdentity: stationSnapshot.identity,
  outcome: result.outcome,
  transportId: result.transport?.transportId || null,
  transportState: result.transport?.state || null,
  receiptId: result.transport?.receipt?.receiptId || null,
  evidenceRef: result.transport?.evidenceRef || null,
  readback: result.transport?.readback || null,
  failure: result.failure || null,
};
console.log(JSON.stringify(evidence, null, 2));
if (result.outcome !== 'VERIFIED' || result.transport?.state !== 'READBACK' || !result.transport?.evidenceRef) process.exitCode = 2;
