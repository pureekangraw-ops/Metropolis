export const MAP_INTERPRETATION_LOCK_VERSION = '1.0.0';

export const NODE_KIND = Object.freeze({
  CITY: 'CITY',
  BUILDING: 'BUILDING',
  WORK_SYSTEM: 'WORK_SYSTEM',
  AGENT_RUNTIME: 'AGENT_RUNTIME',
  SECRETARY: 'SECRETARY',
  STATION: 'STATION',
  DESTINATION: 'DESTINATION',
  TRANSPORT: 'TRANSPORT',
  CARGO_SURFACE: 'CARGO_SURFACE',
});

export const TRAVELER_KIND = Object.freeze({
  PEOPLE_AGENT: 'PEOPLE_AGENT',
  DATA_CARGO: 'DATA_CARGO',
});

export const MOVEMENT_MODE = Object.freeze({
  PATH: 'PATH',
  RAIL: 'RAIL',
});

export const FORBIDDEN_SUBSYSTEMS = Object.freeze([
  'GATE',
  'OATH',
  'MAINTENANCE',
]);

export const REQUIRED_HALL_FLOW = Object.freeze([
  'HERMES',
  'WORK_SYSTEM',
  'MIMIR',
]);

const EXPECTED_PARENTS = Object.freeze({
  HALL: 'METROPOLIS',
  SHOP: 'METROPOLIS',
  THE_TAILOR: 'METROPOLIS',
  PIXIE_SERVICE: 'METROPOLIS',
  POST_OFFICE: 'METROPOLIS',
  HERMES: 'HALL',
  WORK_SYSTEM: 'HALL',
  MIMIR: 'HALL',
});

function text(value) {
  return String(value ?? '').trim();
}

function upper(value) {
  return text(value).toUpperCase();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function error(code, detail) {
  return Object.freeze({ code, detail });
}

function nodeMap(nodes) {
  const map = new Map();
  for (const node of list(nodes)) {
    const id = upper(node?.id);
    if (id && !map.has(id)) map.set(id, node);
  }
  return map;
}

function validateNodes(nodes, errors) {
  const seen = new Set();
  for (const node of list(nodes)) {
    const id = upper(node?.id);
    if (!id) {
      errors.push(error('NODE_ID_REQUIRED', 'Every map node needs an id.'));
      continue;
    }
    if (seen.has(id)) errors.push(error('NODE_DUPLICATE', id));
    seen.add(id);

    if (FORBIDDEN_SUBSYSTEMS.includes(id)) {
      errors.push(error('FORBIDDEN_SUBSYSTEM', id));
    }

    const expectedParent = EXPECTED_PARENTS[id];
    if (expectedParent && upper(node.parent) !== expectedParent) {
      errors.push(error('BOUNDARY_CHANGED', `${id} must be under ${expectedParent}.`));
    }
  }
}

function validateHallFlow(flow, errors) {
  const actual = list(flow).map(upper);
  if (actual.length !== REQUIRED_HALL_FLOW.length || actual.some((id, index) => id !== REQUIRED_HALL_FLOW[index])) {
    errors.push(error('HALL_FLOW_CHANGED', 'HALL flow must remain HERMES → WORK_SYSTEM → MIMIR.'));
  }
}

function validateStations(stations, nodes, errors) {
  const knownNodes = nodeMap(nodes);
  for (const station of list(stations)) {
    const stationId = upper(station?.stationId || station?.id);
    const destinationId = upper(station?.destinationId || station?.destination);
    if (!stationId) errors.push(error('STATION_ID_REQUIRED', 'Every station link needs a stationId.'));
    if (!destinationId) errors.push(error('DESTINATION_ID_REQUIRED', `${stationId || 'Station'} needs a destinationId.`));
    if (stationId && destinationId && stationId === destinationId) {
      errors.push(error('STATION_EQUALS_DESTINATION', `${stationId} cannot also be its destination.`));
    }

    const stationNode = knownNodes.get(stationId);
    const destinationNode = knownNodes.get(destinationId);
    if (stationNode && upper(stationNode.kind) !== NODE_KIND.STATION) {
      errors.push(error('STATION_KIND_INVALID', `${stationId} must be a STATION node.`));
    }
    if (destinationNode && upper(destinationNode.kind) === NODE_KIND.STATION) {
      errors.push(error('DESTINATION_IS_STATION', `${destinationId} must remain a destination, not a station.`));
    }
  }
}

function validateRoutes(routes, errors) {
  for (const route of list(routes)) {
    const mode = upper(route?.mode);
    const traveler = upper(route?.traveler);
    const via = list(route?.via).map(upper);
    const crossesSystemBoundary = route?.crossesSystemBoundary === true;
    const stationId = upper(route?.stationId);
    if (!Object.values(MOVEMENT_MODE).includes(mode)) {
      errors.push(error('MOVEMENT_MODE_INVALID', `${route?.id || 'Route'} must use PATH or RAIL.`));
    }
    if (!Object.values(TRAVELER_KIND).includes(traveler)) {
      errors.push(error('TRAVELER_KIND_INVALID', `${route?.id || 'Route'} must identify people/agent or data/cargo.`));
    }
    if (traveler === TRAVELER_KIND.DATA_CARGO && crossesSystemBoundary) {
      if (mode !== MOVEMENT_MODE.RAIL) {
        errors.push(error('CARGO_REQUIRES_RAIL', `${route?.id || 'Cargo route'} crossing a system boundary must use RAIL.`));
      }
      if (!stationId) {
        errors.push(error('CARGO_REQUIRES_STATION', `${route?.id || 'Cargo route'} crossing a system boundary must name a Station.`));
      }
    }
    if (traveler === TRAVELER_KIND.PEOPLE_AGENT && via.includes('POST_OFFICE')) {
      errors.push(error('PEOPLE_MUST_NOT_USE_POST_OFFICE', `${route?.id || 'Agent route'} cannot use POST_OFFICE.`));
    }
  }
}

export function validateMapInterpretation(spec = {}) {
  const errors = [];
  const nodes = list(spec.nodes);
  const ids = new Set(nodes.map(node => upper(node?.id)).filter(Boolean));

  for (const required of ['METROPOLIS', 'HALL', 'HERMES', 'WORK_SYSTEM', 'MIMIR']) {
    if (!ids.has(required)) errors.push(error('REQUIRED_NODE_MISSING', required));
  }

  validateNodes(nodes, errors);
  validateHallFlow(spec.hallFlow, errors);
  validateStations(spec.stations, nodes, errors);
  validateRoutes(spec.routes, errors);

  return Object.freeze({
    version: MAP_INTERPRETATION_LOCK_VERSION,
    ok: errors.length === 0,
    errors: Object.freeze(errors),
  });
}

export function assertMapInterpretation(spec = {}) {
  const result = validateMapInterpretation(spec);
  if (!result.ok) {
    const failure = new Error('MAP_INTERPRETATION_LOCK_VIOLATION');
    failure.code = 'MAP_INTERPRETATION_LOCK_VIOLATION';
    failure.errors = result.errors;
    throw failure;
  }
  return result;
}
