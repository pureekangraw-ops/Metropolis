import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkPass} from '../src/work-pass.mjs';
import { createObservatoryStation } from '../src/observatory-station.mjs';

function storage() {
  const values = new Map();
  return {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { return values.delete(key); },
  };
}

function runtime({ ownerSystem = 'OBSERVATORY', state = 'RECEIVED',actor='GO' } = {}) {
  const work = { workId: 'W-OBS', checkpointId: 'CP-01', ownerSystem, state,workPass:createWorkPass({workId:'W-OBS',checkpointId:'CP-01',actor}) };
  return { async getWork(workId) { return workId === work.workId ? structuredClone(work) : null; } };
}

function snapshot(view, now = Date.now()) {
  if (view === 'browser') return {
    schema: 'observer.snapshot.v1',
    captureId: 'capture-1',
    revision: 1,
    sequence: 1,
    epoch: 1,
    capturedAtEpochMs: now,
    tabId: 'tab-1',
    url: 'https://example.com/path?private=1',
    title: 'Example',
    text: 'A visible page',
    targets: [],
    truncated: false,
  };
  return {
    schema: 'observatory.map.snapshot.v1',
    captureId: 'map-1',
    revision: 1,
    sequence: 1,
    epoch: 1,
    capturedAtEpochMs: now,
    state: { zones: [], grids: [], pins: [], notes: [] },
  };
}

test('pairing uses existing GO Work and readback emits a durable Metropolis receipt', async () => {
  const store = storage();
  const station = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: store,
    runtime: runtime(),
  });
  const pair = await station.pair({ actor: 'GO', workId: 'W-OBS' });
  assert.equal(pair.publishSnapshot, `https://city.example/observatory/device/${pair.deviceId}/snapshot`);
  assert.equal(typeof pair.token, 'string');
  assert.equal(pair.expiresWhenWorkCloses, true);

  const accepted = await station.publish({
    deviceId: pair.deviceId,
    token: pair.token,
    view: 'browser',
    snapshot: snapshot('browser'),
  });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.businessOutcome, 'UNKNOWN');

  const result = await station.observe({
    actor: 'GO',
    workId: 'W-OBS',
    checkpointId: 'CP-01',
    view: 'browser',
  });
  assert.equal(result.readbackVerified, true);
  assert.equal(result.snapshot.url, 'https://example.com/path');
  assert.equal(result.receipt.kind, 'METROPOLIS_STATION_RECEIPT_V1');
  assert.equal(result.receipt.stationId, 'OBSERVATORY_STATION');
  assert.equal(result.receipt.status, 'READBACK_VERIFIED');
  assert.equal(result.receipt.businessOutcome, 'UNKNOWN');
});

test('Station refuses mismatched identity, Work owner, and closed Work', async () => {
  const station = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: storage(),
    runtime: runtime(),
  });
  await assert.rejects(station.pair({ actor: 'LIGHT', workId: 'W-OBS' }), /NO_GRANT/);
  const wrongOwner = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: storage(),
    runtime: runtime({ ownerSystem: 'FACTORY' }),
  });
  await assert.rejects(wrongOwner.pair({ actor: 'GO', workId: 'W-OBS' }), /WORK_OWNER_MISMATCH/);
  const closed = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: storage(),
    runtime: runtime({ state: 'COMPLETED' }),
  });
  await assert.rejects(closed.pair({ actor: 'GO', workId: 'W-OBS' }), /WORK_CLOSED/);
});

test('device rail rejects forged Work identity, stale captures, and superseded credentials', async () => {
  const store = storage();
  const station = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: store,
    runtime: runtime(),
  });
  const first = await station.pair({ actor: 'GO', workId: 'W-OBS' });
  await assert.rejects(station.publish({
    deviceId: first.deviceId,
    token: first.token,
    view: 'browser',
    snapshot: { ...snapshot('browser'), checkpointId: 'forged' },
  }), /CALLER_CONTEXT_DENIED/);
  await assert.rejects(station.publish({
    deviceId: first.deviceId,
    token: first.token,
    view: 'browser',
    snapshot: snapshot('browser', Date.now() - 60_000),
  }), /STALE_CAPTURE/);
  const second = await station.pair({ actor: 'GO', workId: 'W-OBS' });
  await assert.rejects(station.publish({
    deviceId: first.deviceId,
    token: first.token,
    view: 'browser',
    snapshot: snapshot('browser'),
  }), /AUTH_REQUIRED/);
  assert.equal(second.deviceId === first.deviceId, false);
  await assert.rejects(station.observe({
    actor: 'GO',
    workId: 'W-OBS',
    checkpointId: 'CP-01',
    view: 'browser',
  }), /READBACK_CONTEXT_MISMATCH/);
});

test('disconnect revokes the device and clears its linked readback', async () => {
  const store = storage();
  const station = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: store,
    runtime: runtime(),
  });
  const pair = await station.pair({ actor: 'GO', workId: 'W-OBS' });
  await station.publish({
    deviceId: pair.deviceId,
    token: pair.token,
    view: 'browser',
    snapshot: snapshot('browser'),
  });
  assert.deepEqual(await station.disconnect({ deviceId: pair.deviceId, token: pair.token }), {
    disconnected: true,
    stationId: 'OBSERVATORY_STATION',
  });
  await assert.rejects(station.publish({
    deviceId: pair.deviceId,
    token: pair.token,
    view: 'browser',
    snapshot: snapshot('browser'),
  }), /AUTH_REQUIRED/);
  await assert.rejects(station.observe({
    actor: 'GO',
    workId: 'W-OBS',
    checkpointId: 'CP-01',
    view: 'browser',
  }), /DEVICE_NOT_PAIRED/);
});

test('readback requires a paired device and a fresh capture', async () => {
  let now = Date.now();
  const station = createObservatoryStation({
    env: { MCP_PUBLIC_ORIGIN: 'https://city.example' },
    storage: storage(),
    runtime: runtime(),
    clock: () => now,
  });
  await assert.rejects(station.observe({
    actor: 'GO',
    workId: 'W-OBS',
    checkpointId: 'CP-01',
    view: 'map',
  }), /DEVICE_NOT_PAIRED/);
  const pair = await station.pair({ actor: 'GO', workId: 'W-OBS' });
  await station.publish({ deviceId: pair.deviceId, token: pair.token, view: 'map', snapshot: snapshot('map', now) });
  now += 60_000;
  await assert.rejects(station.observe({
    actor: 'GO',
    workId: 'W-OBS',
    checkpointId: 'CP-01',
    view: 'map',
  }), /STALE_CAPTURE/);
});
test('LIGHT can pair and observe its own Work Pass without GO identity',async()=>{
 const station=createObservatoryStation({env:{MCP_PUBLIC_ORIGIN:'https://city.example'},storage:storage(),runtime:runtime({actor:'LIGHT'})});
 const pair=await station.pair({actor:'LIGHT',workId:'W-OBS'});
 await station.publish({deviceId:pair.deviceId,token:pair.token,view:'browser',snapshot:snapshot('browser')});
 const observed=await station.observe({actor:'LIGHT',workId:'W-OBS',view:'browser'});
 assert.equal(observed.receipt.actor,'LIGHT');assert.equal(observed.readbackVerified,true);
});
