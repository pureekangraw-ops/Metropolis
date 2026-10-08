import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStationPlan, STATION_PLAN_V1, validateStationPlan } from '../src/station-plan.mjs';

test('Station Plan binds Observatory to Metropolis and Factory to its ready runtime', () => {
  assert.equal(assertStationPlan(STATION_PLAN_V1).ok, true);
  assert.equal(STATION_PLAN_V1.runtimeConnected, true);
  assert.equal(STATION_PLAN_V1.stations.find((station) => station.stationId === 'FACTORY_STATION').runtimeBinding.endpoint, 'https://factory-district.pureekangraw.workers.dev');
  const observatory = STATION_PLAN_V1.stations.find((station) => station.stationId === 'OBSERVATORY_STATION');
  assert.deepEqual(observatory.runtimeBinding, { kind: 'METROPOLIS_ENTRY', binding: 'METROPOLIS_ENTRY', path: '/observatory' });
  assert.deepEqual(observatory.cargoKinds, ['DATA', 'EVIDENCE']);
  assert.equal(STATION_PLAN_V1.stations.filter((station) => !['FACTORY_STATION', 'OBSERVATORY_STATION'].includes(station.stationId)).every((station) => station.runtimeBinding === null), true);
});

test('Station Plan keeps Drive and Notion distinct', () => {
  const plan = structuredClone(STATION_PLAN_V1);
  plan.stations.find((station) => station.stationId === 'NOTION_STATION').destinationId = 'GOOGLE_DRIVE';
  assert.equal(validateStationPlan(plan).errors.some((error) => error.code === 'DESTINATION_DUPLICATE'), true);
});

test('Station Plan does not infer actor travel for Drive or Notion', () => {
  for (const stationId of ['DRIVE_STATION', 'NOTION_STATION']) {
    const station = STATION_PLAN_V1.stations.find((item) => item.stationId === stationId);
    assert.equal(station.cargoKinds.includes('PEOPLE_AGENT'), false);
  }
  for (const stationId of ['FACTORY_STATION', 'PRISM_STATION']) {
    const station = STATION_PLAN_V1.stations.find((item) => item.stationId === stationId);
    assert.equal(station.cargoKinds.includes('PEOPLE_AGENT'), true);
  }
});
