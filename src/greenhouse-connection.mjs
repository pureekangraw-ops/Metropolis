import { createStation, createRail } from './contract.mjs';
import { createGreenhouseRailAdapter } from './stations/greenhouse.mjs';

export const GREENHOUSE_STATION_ID = 'GREENHOUSE_STATION';
export const GREENHOUSE_RAIL_ID = 'RAIL_GREENHOUSE';

export function connectGreenhouse(engine, options) {
  const station = createStation({ stationId: GREENHOUSE_STATION_ID, railId: GREENHOUSE_RAIL_ID, ownerSystem: 'GREENHOUSE', credentialRef: 'credential://greenhouse/transport' });
  const rail = createRail({ stationId: station.stationId, railId: station.railId, ownerSystem: station.ownerSystem });
  engine.registerStation({ station, rail, adapter: createGreenhouseRailAdapter(options) });
  return { stationId: station.stationId, railId: rail.railId };
}

export function handoffViaGreenhouse(engine, { actor, workId, checkpointId, workPassRef, targetStation, operation, payload = {} }) {
  if (![actor, workId, checkpointId, workPassRef, targetStation, operation].every(x => typeof x === 'string' && x.trim())) throw new TypeError('GREENHOUSE_HANDOFF_CONTEXT_REQUIRED');
  if (targetStation === GREENHOUSE_STATION_ID) throw new TypeError('GREENHOUSE_RECURSION_DENIED');
  return engine.travel({ actor, workId, stationId: GREENHOUSE_STATION_ID, operation: 'COORDINATE_HANDOFF', payload: { workId, checkpointId, workPassRef, actingActor: actor, targetStation, operation, payload } });
}