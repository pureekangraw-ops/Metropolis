export const STATION_PLAN_VERSION = '1.1.0';

export const STATION_PLAN_STATUS = Object.freeze({
  PLANNED: 'PLANNED',
  READY_TO_BIND: 'READY_TO_BIND',
});

export const CARGO_KIND = Object.freeze({
  PEOPLE_AGENT: 'PEOPLE_AGENT',
  DATA: 'DATA',
  ARTIFACT: 'ARTIFACT',
  EVIDENCE: 'EVIDENCE',
});

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const plannedStations = [
  {
    stationId: 'FACTORY_STATION', destinationId: 'FACTORY', ownerSystem: 'FACTORY',
    status: STATION_PLAN_STATUS.READY_TO_BIND,
    cargoKinds: [CARGO_KIND.PEOPLE_AGENT, CARGO_KIND.DATA, CARGO_KIND.ARTIFACT, CARGO_KIND.EVIDENCE], runtimeBinding: null,
  },
  {
    stationId: 'PRISM_STATION', destinationId: 'PRISM', ownerSystem: 'PRISM',
    status: STATION_PLAN_STATUS.READY_TO_BIND,
    cargoKinds: [CARGO_KIND.PEOPLE_AGENT, CARGO_KIND.DATA, CARGO_KIND.ARTIFACT, CARGO_KIND.EVIDENCE], runtimeBinding: null,
  },
  {
    stationId: 'DRIVE_STATION', destinationId: 'GOOGLE_DRIVE', ownerSystem: 'GOOGLE_DRIVE',
    status: STATION_PLAN_STATUS.READY_TO_BIND,
    cargoKinds: [CARGO_KIND.DATA, CARGO_KIND.ARTIFACT, CARGO_KIND.EVIDENCE], runtimeBinding: null,
  },
  {
    stationId: 'NOTION_STATION', destinationId: 'NOTION', ownerSystem: 'NOTION',
    status: STATION_PLAN_STATUS.READY_TO_BIND,
    cargoKinds: [CARGO_KIND.DATA, CARGO_KIND.ARTIFACT, CARGO_KIND.EVIDENCE], runtimeBinding: null,
  },
];

const FACTORY_RUNTIME_URL = 'https://factory-district.pureekangraw.workers.dev';
plannedStations[0].runtimeBinding = freeze({ kind: 'HTTP_RUNTIME', endpoint: FACTORY_RUNTIME_URL });
export const STATION_PLAN_V1 = freeze({ version: STATION_PLAN_VERSION, runtimeConnected: true, stations: plannedStations });

function planError(code, detail) { return Object.freeze({ code, detail }); }

export function validateStationPlan(plan = STATION_PLAN_V1) {
  const errors = [];
  if (typeof plan.runtimeConnected !== 'boolean') errors.push(planError('RUNTIME_CONNECTED_REQUIRED', 'Station Plan must declare runtime connection state.'));
  const seenStations = new Set();
  const seenDestinations = new Set();
  for (const station of Array.isArray(plan.stations) ? plan.stations : []) {
    const stationId = String(station?.stationId || '').trim().toUpperCase();
    const destinationId = String(station?.destinationId || '').trim().toUpperCase();
    if (!stationId) errors.push(planError('STATION_ID_REQUIRED', 'Station ID is required.'));
    if (!destinationId) errors.push(planError('DESTINATION_ID_REQUIRED', `${stationId || 'Station'} needs a destination.`));
    if (stationId === destinationId) errors.push(planError('STATION_EQUALS_DESTINATION', stationId));
    if (seenStations.has(stationId)) errors.push(planError('STATION_DUPLICATE', stationId));
    if (seenDestinations.has(destinationId)) errors.push(planError('DESTINATION_DUPLICATE', destinationId));
    seenStations.add(stationId); seenDestinations.add(destinationId);
    if (station.status !== STATION_PLAN_STATUS.READY_TO_BIND) errors.push(planError('STATION_NOT_READY_TO_BIND', stationId));
    if (station.runtimeBinding !== null && station.status !== STATION_PLAN_STATUS.READY_TO_BIND) errors.push(planError('RUNTIME_BINDING_INVALID', stationId));
    if (!Array.isArray(station.cargoKinds) || station.cargoKinds.length === 0) errors.push(planError('CARGO_KINDS_REQUIRED', stationId));
  }
  return freeze({ version: STATION_PLAN_VERSION, ok: errors.length === 0, errors });
}

export function assertStationPlan(plan = STATION_PLAN_V1) {
  const result = validateStationPlan(plan);
  if (!result.ok) {
    const failure = new Error('STATION_PLAN_INVALID');
    failure.code = 'STATION_PLAN_INVALID'; failure.errors = result.errors; throw failure;
  }
  return result;
}
