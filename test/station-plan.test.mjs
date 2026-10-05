import test from 'node:test';
import assert from 'node:assert/strict';
import { assertStationPlan, STATION_PLAN_V1, validateStationPlan } from '../src/station-plan.mjs';

test('Station Plan v1 is ready to bind but does not connect runtime', () => {
  assert.equal(assertStationPlan(STATION_PLAN_V1).ok, true);
  assert.equal(STATION_PLAN_V1.runtimeConnected, false);
  assert.equal(STATION_PLAN_V1.stations.every((station) => station.runtimeBinding === null), true);
});

test('Station Plan keeps Drive and Notion distinct', () => {
  const plan = structuredClone(STATION_PLAN_V1);
  plan.stations.find((station) => station.stationId === 'NOTION_STATION').destinationId = 'GOOGLE_DRIVE';
  assert.equal(validateStationPlan(plan).errors.some((error) => error.code === 'DESTINATION_DUPLICATE'), true);
});
