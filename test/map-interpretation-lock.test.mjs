import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMapInterpretation,
  MOVEMENT_MODE,
  NODE_KIND,
  TRAVELER_KIND,
  validateMapInterpretation,
} from '../src/map-interpretation-lock.mjs';

function baseSpec() {
  return {
    nodes: [
      { id: 'METROPOLIS', kind: NODE_KIND.CITY },
      { id: 'HALL', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
      { id: 'SHOP', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
      { id: 'THE_TAILOR', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
      { id: 'PIXIE_SERVICE', kind: NODE_KIND.BUILDING, parent: 'METROPOLIS' },
      { id: 'POST_OFFICE', kind: NODE_KIND.CARGO_SURFACE, parent: 'METROPOLIS' },
      { id: 'HERMES', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
      { id: 'WORK_SYSTEM', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
      { id: 'MIMIR', kind: NODE_KIND.WORK_SYSTEM, parent: 'HALL' },
      { id: 'FACTORY_STATION', kind: NODE_KIND.STATION, parent: 'METROPOLIS' },
      { id: 'FACTORY', kind: NODE_KIND.DESTINATION, parent: 'METROPOLIS' },
    ],
    hallFlow: ['HERMES', 'WORK_SYSTEM', 'MIMIR'],
    stations: [{ stationId: 'FACTORY_STATION', destinationId: 'FACTORY' }],
    routes: [
      { id: 'GO_TO_FACTORY', mode: MOVEMENT_MODE.RAIL, traveler: TRAVELER_KIND.PEOPLE_AGENT, via: ['FACTORY_STATION'] },
      { id: 'RETURN_ARTIFACT', mode: MOVEMENT_MODE.RAIL, traveler: TRAVELER_KIND.DATA_CARGO, crossesSystemBoundary: true, stationId: 'FACTORY_STATION', via: ['FACTORY_STATION', 'POST_OFFICE'] },
    ],
  };
}

test('accepts the locked Metropolis interpretation', () => {
  assert.equal(assertMapInterpretation(baseSpec()).ok, true);
});

test('keeps Hall flow and external runtime boundaries fixed', () => {
  const spec = baseSpec();
  spec.hallFlow = ['HERMES', 'MIMIR', 'WORK_SYSTEM'];
  spec.nodes.find(node => node.id === 'PIXIE_SERVICE').parent = 'HALL';
  const result = validateMapInterpretation(spec);
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map(item => item.code), ['BOUNDARY_CHANGED', 'HALL_FLOW_CHANGED']);
});

test('rejects station-as-destination collapse', () => {
  const spec = baseSpec();
  spec.stations[0].destinationId = 'FACTORY_STATION';
  assert.throws(() => assertMapInterpretation(spec), error => error.code === 'MAP_INTERPRETATION_LOCK_VIOLATION'
    && error.errors.some(item => item.code === 'STATION_EQUALS_DESTINATION'));
});

test('allows local cargo on Path but requires Station and Rail across a system boundary', () => {
  const localCargo = baseSpec();
  localCargo.routes[1].mode = MOVEMENT_MODE.PATH;
  localCargo.routes[1].crossesSystemBoundary = false;
  delete localCargo.routes[1].stationId;
  assert.equal(validateMapInterpretation(localCargo).ok, true);

  const cargoOnPathAcrossBoundary = baseSpec();
  cargoOnPathAcrossBoundary.routes[1].mode = MOVEMENT_MODE.PATH;
  assert.equal(validateMapInterpretation(cargoOnPathAcrossBoundary).errors[0].code, 'CARGO_REQUIRES_RAIL');

  const cargoOnRailWithoutStation = baseSpec();
  delete cargoOnRailWithoutStation.routes[1].stationId;
  assert.equal(validateMapInterpretation(cargoOnRailWithoutStation).errors[0].code, 'CARGO_REQUIRES_STATION');
});

test('keeps people away from Post Office', () => {
  const peopleThroughPost = baseSpec();
  peopleThroughPost.routes[0].via = ['POST_OFFICE'];
  assert.equal(validateMapInterpretation(peopleThroughPost).errors[0].code, 'PEOPLE_MUST_NOT_USE_POST_OFFICE');
});

test('rejects introducing Gate, Oath, or Maintenance as renamed subsystems', () => {
  const spec = baseSpec();
  spec.nodes.push({ id: 'MAINTENANCE', kind: NODE_KIND.WORK_SYSTEM, parent: 'METROPOLIS' });
  assert.equal(validateMapInterpretation(spec).errors.at(-1).code, 'FORBIDDEN_SUBSYSTEM');
});
