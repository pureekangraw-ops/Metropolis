import {
  MOVEMENT_MODE,
  NODE_KIND,
  TRAVELER_KIND,
  validateMapInterpretation,
} from './map-interpretation-lock.mjs';

export const SYSTEM_MAP_V1_VERSION = '1.0.0';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const nodes = [
  {id:'OBSERVATORY_STATION',kind:NODE_KIND.STATION,parent:'METROPOLIS'},
  {id:'OBSERVATORY',kind:NODE_KIND.DESTINATION,parent:'EXTERNAL_SYSTEM'},
  { id: 'METROPOLIS', kind: NODE_KIND.CITY },
  { id: 'SHOP', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
  { id: 'SPECTRUMSALE', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS', attachedTo: 'SHOP' },
  { id: 'THE_TAILOR', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
  { id: 'HALL', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
  { id: 'HERMES', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
  { id: 'HERMES_SECRETARY', kind: NODE_KIND.SECRETARY, parent: 'HERMES', attachedTo: 'HERMES' },
  { id: 'WORK_SYSTEM', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
  { id: 'MIMIR', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
  { id: 'MIMIR_SECRETARY', kind: NODE_KIND.SECRETARY, parent: 'MIMIR', attachedTo: 'MIMIR' },
  { id: 'PIXIE_SERVICE', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
  { id: 'POST_OFFICE', kind: NODE_KIND.CARGO_SURFACE, parent: 'METROPOLIS' },
  { id: 'RAIL', kind: NODE_KIND.TRANSPORT, parent: 'METROPOLIS' },
  { id: 'FACTORY_STATION', kind: NODE_KIND.STATION, parent: 'METROPOLIS' },
  { id: 'PRISM_STATION', kind: NODE_KIND.STATION, parent: 'METROPOLIS' },
  { id: 'DRIVE_STATION', kind: NODE_KIND.STATION, parent: 'METROPOLIS' },
  { id: 'NOTION_STATION', kind: NODE_KIND.STATION, parent: 'METROPOLIS' },
  { id: 'FACTORY', kind: NODE_KIND.DESTINATION, parent: 'EXTERNAL_SYSTEM' },
  { id: 'PRISM', kind: NODE_KIND.DESTINATION, parent: 'EXTERNAL_SYSTEM' },
  { id: 'GOOGLE_DRIVE', kind: NODE_KIND.DESTINATION, parent: 'EXTERNAL_SYSTEM' },
  { id: 'NOTION', kind: NODE_KIND.DESTINATION, parent: 'EXTERNAL_SYSTEM' },
];

const paths = [
  { id: 'SHOP_TO_HALL', from: 'SHOP', to: 'HALL', mode: MOVEMENT_MODE.PATH, traveler: TRAVELER_KIND.PEOPLE_AGENT },
  { id: 'TAILOR_TO_HALL', from: 'THE_TAILOR', to: 'HALL', mode: MOVEMENT_MODE.PATH, traveler: TRAVELER_KIND.PEOPLE_AGENT },
  { id: 'HALL_TO_PIXIE_SERVICE', from: 'HALL', to: 'PIXIE_SERVICE', mode: MOVEMENT_MODE.PATH, traveler: TRAVELER_KIND.PEOPLE_AGENT },
  { id: 'MIMIR_TO_POST_OFFICE', from: 'MIMIR', to: 'POST_OFFICE', mode: MOVEMENT_MODE.PATH, traveler: TRAVELER_KIND.DATA_CARGO, crossesSystemBoundary: false },
  { id: 'SECRETARY_TO_POST_OFFICE', from: 'MIMIR_SECRETARY', to: 'POST_OFFICE', mode: MOVEMENT_MODE.PATH, traveler: TRAVELER_KIND.DATA_CARGO, crossesSystemBoundary: false },
];

const stations = [
  {stationId:'OBSERVATORY_STATION',destinationId:'OBSERVATORY',ownerSystem:'OBSERVATORY'},
  { stationId: 'FACTORY_STATION', destinationId: 'FACTORY', ownerSystem: 'FACTORY' },
  { stationId: 'PRISM_STATION', destinationId: 'PRISM', ownerSystem: 'PRISM' },
  { stationId: 'DRIVE_STATION', destinationId: 'GOOGLE_DRIVE', ownerSystem: 'GOOGLE_DRIVE' },
  { stationId: 'NOTION_STATION', destinationId: 'NOTION', ownerSystem: 'NOTION' },
];

const rails = stations.map((station) => ({
  id: `RAIL_${station.ownerSystem}`,
  stationId: station.stationId,
  destinationId: station.destinationId,
  mode: MOVEMENT_MODE.RAIL,
  travelerKinds: [TRAVELER_KIND.PEOPLE_AGENT, TRAVELER_KIND.DATA_CARGO],
}));

export const SYSTEM_MAP_V1 = freeze({
  id: 'METROPOLIS_SYSTEM_MAP_V1',
  version: SYSTEM_MAP_V1_VERSION,
  nodes,
  hallFlow: ['HERMES', 'WORK_SYSTEM', 'MIMIR'],
  paths,
  stations,
  rails,
});

function mapError(code, detail) {
  return Object.freeze({ code, detail });
}

function ids(items = []) {
  return new Set(items.map((item) => String(item?.id || '').trim().toUpperCase()).filter(Boolean));
}

export function validateSystemMapV1(map = SYSTEM_MAP_V1) {
  const errors = [];
  const interpretation = validateMapInterpretation({
    nodes: map.nodes,
    hallFlow: map.hallFlow,
    stations: map.stations,
    routes: map.paths || [],
  });
  errors.push(...interpretation.errors);

  const nodeIds = ids(map.nodes);
  for (const required of ['SHOP', 'SPECTRUMSALE', 'THE_TAILOR', 'PIXIE_SERVICE', 'POST_OFFICE', 'RAIL', 'HERMES_SECRETARY', 'MIMIR_SECRETARY']) {
    if (!nodeIds.has(required)) errors.push(mapError('MAP_NODE_MISSING', required));
  }

  const nodeById = new Map((map.nodes || []).map((node) => [String(node.id).toUpperCase(), node]));
  for (const secretary of ['HERMES_SECRETARY', 'MIMIR_SECRETARY']) {
    const node = nodeById.get(secretary);
    if (node && String(node.kind || '').toUpperCase() !== NODE_KIND.SECRETARY) {
      errors.push(mapError('SECRETARY_RUNTIME_IDENTITY', `${secretary} must use SECRETARY kind.`));
    }
    if (node && String(node.attachedTo || '').toUpperCase() !== secretary.replace('_SECRETARY', '')) {
      errors.push(mapError('SECRETARY_DETACHED', secretary));
    }
  }

  const stationIds = new Set();
  const destinationIds = new Set();
  for (const station of map.stations || []) {
    const stationId = String(station.stationId || '').toUpperCase();
    const destinationId = String(station.destinationId || '').toUpperCase();
    if (stationIds.has(stationId)) errors.push(mapError('STATION_DUPLICATE', stationId));
    if (destinationIds.has(destinationId)) errors.push(mapError('DESTINATION_DUPLICATE', destinationId));
    stationIds.add(stationId);
    destinationIds.add(destinationId);
    if (stationId === destinationId) errors.push(mapError('STATION_EQUALS_DESTINATION', stationId));
  }

  const driveStation = (map.stations || []).find((station) => station.stationId === 'DRIVE_STATION');
  const notionStation = (map.stations || []).find((station) => station.stationId === 'NOTION_STATION');
  if (!driveStation || driveStation.destinationId !== 'GOOGLE_DRIVE') errors.push(mapError('DRIVE_STATION_INVALID', 'DRIVE_STATION must connect to GOOGLE_DRIVE.'));
  if (!notionStation || notionStation.destinationId !== 'NOTION') errors.push(mapError('NOTION_STATION_INVALID', 'NOTION_STATION must connect to NOTION.'));
  if (driveStation && notionStation && driveStation.stationId === notionStation.stationId) errors.push(mapError('DRIVE_NOTION_STATION_COLLAPSED', 'Drive and Notion need separate Stations.'));

  for (const path of map.paths || []) {
    if (path.mode !== MOVEMENT_MODE.PATH) errors.push(mapError('PATH_MODE_INVALID', path.id));
  }
  for (const rail of map.rails || []) {
    if (rail.mode !== MOVEMENT_MODE.RAIL) errors.push(mapError('RAIL_MODE_INVALID', rail.id));
    if (!stationIds.has(String(rail.stationId || '').toUpperCase())) errors.push(mapError('RAIL_STATION_UNKNOWN', rail.id));
    if (!destinationIds.has(String(rail.destinationId || '').toUpperCase())) errors.push(mapError('RAIL_DESTINATION_UNKNOWN', rail.id));
  }

  return freeze({ version: SYSTEM_MAP_V1_VERSION, ok: errors.length === 0, errors });
}

export function assertSystemMapV1(map = SYSTEM_MAP_V1) {
  const result = validateSystemMapV1(map);
  if (!result.ok) {
    const failure = new Error('SYSTEM_MAP_V1_INVALID');
    failure.code = 'SYSTEM_MAP_V1_INVALID';
    failure.errors = result.errors;
    throw failure;
  }
  return result;
}
