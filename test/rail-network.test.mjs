import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthorityBoundary } from '../src/authority.mjs';
import { createRail, createStation } from '../src/contract.mjs';
import { createConnectionEngine, STATION_STATUS } from '../src/rail-network.mjs';

function pair({ stationId, railId, ownerSystem, adapter }) {
  return {
    station: createStation({ stationId, railId, ownerSystem, credentialRef: `credential://${ownerSystem.toLowerCase()}/main` }),
    rail: createRail({ stationId, railId, ownerSystem }),
    adapter,
  };
}

function readyAdapter({ verified = true } = {}) {
  return {
    async probe() { return { status: STATION_STATUS.READY, scope: ['READ_REPOSITORY'], connectivity: { status: STATION_STATUS.READY }, readback: { supported: true }, observedAt: '2026-10-05T00:00:01Z' }; },
    async dispatch() { return { accepted: true, receiptId: 'receipt-1', providerRef: 'provider://receipt', acceptedAt: '2026-10-05T00:00:02Z' }; },
    async readback() { return { verified, evidenceRef: verified ? 'evidence://readback-1' : null, observedAt: '2026-10-05T00:00:03Z' }; },
  };
}

test('Connection Engine runs REQUEST to READBACK and returns evidence', async () => {
  const engine = createConnectionEngine({
    idFactory: () => 'TRANSPORT-1',
    clock: (() => { let i = 0; return () => `2026-10-05T00:00:0${i++}Z`; })(),
    authorizer: createAuthorityBoundary([{ actor: 'GO', stationId: 'STATION-GITHUB', operation: 'READ_REPOSITORY', workId: 'WORK-1' }]),
  });
  const { station, rail, adapter } = pair({ stationId: 'STATION-GITHUB', railId: 'RAIL-GITHUB', ownerSystem: 'GITHUB', adapter: readyAdapter() });
  engine.registerStation({ station, rail, adapter });
  const result = await engine.travel({ actor: 'GO', workId: 'WORK-1', stationId: station.stationId, operation: 'READ_REPOSITORY' });
  assert.equal(result.outcome, 'VERIFIED');
  assert.equal(result.transport.state, 'READBACK');
  assert.equal(result.transport.actor, 'GO');
  assert.equal(result.transport.evidenceRef, 'evidence://readback-1');
  assert.deepEqual(result.trace.map((item) => item.state).filter(Boolean), ['REQUEST', 'ACCEPTED', 'DISPATCHED', 'RECEIPT', 'READBACK']);
});

test('Unverified Rail capability stops travel before dispatch', async () => {
  let dispatched = false;
  const adapter = readyAdapter();
  adapter.dispatch = async () => { dispatched = true; return { accepted: true }; };
  const engine = createConnectionEngine({ authorizer: createAuthorityBoundary([{ actor: 'LIGHT', stationId: 'STATION-GITHUB', operation: 'CREATE_BRANCH', workId: 'WORK-2' }]) });
  const { station, rail } = pair({ stationId: 'STATION-GITHUB', railId: 'RAIL-GITHUB', ownerSystem: 'GITHUB', adapter });
  engine.registerStation({ station, rail, adapter });
  const result = await engine.travel({ actor: 'LIGHT', workId: 'WORK-2', stationId: station.stationId, operation: 'CREATE_BRANCH' });
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.failure.stage, 'RAIL');
  assert.equal(result.failure.code, 'RAIL_CAPABILITY_UNKNOWN');
  assert.equal(dispatched, false);
});

test('Denied Agent authority is distinct from a verified Rail capability', async () => {
  let dispatched = false;
  const adapter = readyAdapter();
  adapter.dispatch = async () => { dispatched = true; return { accepted: true }; };
  adapter.probe = async () => ({ status: STATION_STATUS.READY, scope: ['READ_REPOSITORY'], capabilities: { READ_REPOSITORY: { status: 'READY' } }, connectivity: { status: STATION_STATUS.READY }, readback: { supported: true }, observedAt: '2026-10-05T00:00:01Z' });
  const engine = createConnectionEngine({ authorizer: createAuthorityBoundary([]) });
  const { station, rail } = pair({ stationId: 'STATION-GITHUB', railId: 'RAIL-GITHUB', ownerSystem: 'GITHUB', adapter });
  engine.registerStation({ station, rail, adapter });
  const result = await engine.travel({ actor: 'LIGHT', workId: 'WORK-2', stationId: station.stationId, operation: 'READ_REPOSITORY' });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(result.failure.stage, 'AUTH');
  assert.equal(dispatched, false);
});

test('Receipt without verified readback is UNKNOWN, not success', async () => {
  const engine = createConnectionEngine({ authorizer: createAuthorityBoundary([{ actor: 'GO', stationId: 'STATION-GITHUB', operation: 'READ_REPOSITORY' }]) });
  const { station, rail, adapter } = pair({ stationId: 'STATION-GITHUB', railId: 'RAIL-GITHUB', ownerSystem: 'GITHUB', adapter: readyAdapter({ verified: false }) });
  engine.registerStation({ station, rail, adapter });
  const result = await engine.travel({ actor: 'GO', workId: 'WORK-3', stationId: station.stationId, operation: 'READ_REPOSITORY' });
  assert.equal(result.outcome, 'UNKNOWN');
  assert.equal(result.failure.stage, 'READBACK');
  assert.equal(result.transport.state, 'READBACK');
});

test('Station failure is isolated from another ready Station', async () => {
  const engine = createConnectionEngine({ authorizer: createAuthorityBoundary([
    { actor: 'GO', stationId: 'STATION-GITHUB', operation: 'READ_REPOSITORY' },
    { actor: 'GO', stationId: 'STATION-NOTION', operation: 'READ_REPOSITORY' },
  ]) });
  const github = pair({ stationId: 'STATION-GITHUB', railId: 'RAIL-GITHUB', ownerSystem: 'GITHUB', adapter: { async probe() { return { status: STATION_STATUS.UNAVAILABLE }; }, async dispatch() { throw new Error('must not dispatch'); }, async readback() { throw new Error('must not readback'); } } });
  const notion = pair({ stationId: 'STATION-NOTION', railId: 'RAIL-NOTION', ownerSystem: 'NOTION', adapter: readyAdapter() });
  engine.registerStation(github);
  engine.registerStation(notion);
  const failed = await engine.travel({ actor: 'GO', workId: 'WORK-4', stationId: github.station.stationId, operation: 'READ_REPOSITORY' });
  const healthy = await engine.travel({ actor: 'GO', workId: 'WORK-4', stationId: notion.station.stationId, operation: 'READ_REPOSITORY' });
  assert.equal(failed.outcome, 'FAILED');
  assert.equal(failed.failure.stage, 'STATION');
  assert.equal(healthy.outcome, 'VERIFIED');
});
