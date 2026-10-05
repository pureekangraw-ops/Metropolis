import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSystemMapV1, SYSTEM_MAP_V1, validateSystemMapV1 } from '../src/system-map-v1.mjs';

test('System Map v1 passes the interpretation lock', () => { assert.equal(assertSystemMapV1(SYSTEM_MAP_V1).ok, true); });

test('System Map v1 keeps Drive and Notion as separate Stations', () => {
  const map = structuredClone(SYSTEM_MAP_V1);
  map.stations.find((station) => station.stationId === 'NOTION_STATION').stationId = 'DRIVE_STATION';
  assert.equal(validateSystemMapV1(map).errors.some((error) => error.code === 'STATION_DUPLICATE'), true);
});

test('System Map v1 keeps Secretaries as attached capabilities, not runtimes', () => {
  const map = structuredClone(SYSTEM_MAP_V1);
  map.nodes.find((node) => node.id === 'MIMIR_SECRETARY').attachedTo = 'HERMES';
  assert.equal(validateSystemMapV1(map).errors.some((error) => error.code === 'SECRETARY_DETACHED'), true);

  const runtimeSecretary = structuredClone(SYSTEM_MAP_V1);
  runtimeSecretary.nodes.find((node) => node.id === 'MIMIR_SECRETARY').kind = 'AGENT_RUNTIME';
  assert.equal(validateSystemMapV1(runtimeSecretary).errors.some((error) => error.code === 'SECRETARY_RUNTIME_IDENTITY'), true);
});
