import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStationPlan, STATION_PLAN_V1, validateStationPlan } from '../src/station-plan.mjs';

test('Station Plan binds only the ready Factory runtime', () => {
  assert.equal(assertStationPlan(STATION_PLAN_V1).ok, true);
  assert.equal(STATION_PLAN_V1.runtimeConnected, true);
  assert.equal(STATION_PLAN_V1.stations.find((station) => station.stationId === 'FACTORY_STATION').runtimeBinding.endpoint, 'https://factory-district.pureekangraw.workers.dev');
  assert.equal(STATION_PLAN_V1.stations.filter((station) => station.stationId !== 'FACTORY_STATION').every((station) => station.runtimeBinding === null), true);
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
