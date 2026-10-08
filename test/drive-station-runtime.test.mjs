import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveStationRuntime } from '../src/drive-station-runtime.mjs';
import { createWorkPass, workPassRef } from '../src/work-pass.mjs';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';
import { STATION_PLAN_V1, stationPlanForRuntime } from '../src/station-plan.mjs';

const WORK = 'WORK-DRIVE';
const CP = 'CP-01';
const REF = 'r2://factory/metropolis/tablets/WORK-DRIVE/CP-01/artifact/delivery.txt';
const KEY = REF.slice('r2://factory/'.length);
const FILE = 'DRIVEFILE_000000001';
const FOLDER = 'DRIVEFOLDER_000000001';
const encoder = new TextEncoder();

function harness() {
  const state = { uploads: 0, oauth: 0, metadata: null, bytes: null, corrupt: false, requests: [], sourceReads: 0, deleted: false };
  const sourceBytes = encoder.encode('hello Metropolis Post Office\n');
  const bucket = {
    async get(key) {
      state.sourceReads++;
      if (key !== KEY) return null;
      return {
        size: sourceBytes.length,
        httpMetadata: { contentType: 'text/plain' },
        async arrayBuffer() { return sourceBytes.buffer.slice(0); },
      };
    },
    async delete() { state.deleted = true; throw new Error('UNAUTHORIZED_SOURCE_DELETION'); },
  };
  const fetchImpl = async (requestUrl, options = {}) => {
    const u = new URL(requestUrl);
    state.requests.push({ method: options.method || 'GET', url: u.pathname });
    if (u.hostname === 'oauth2.googleapis.com') {
      state.oauth++;
      assert.equal(options.method, 'POST');
      assert.equal(String(options.body.get('grant_type')), 'refresh_token');
      return Response.json({ access_token: 'test-token', token_type: 'Bearer', expires_in: 3600 });
    }
    assert.equal(u.hostname, 'www.googleapis.com');
    assert.equal(options.headers?.authorization, 'Bearer test-token');
    if (u.pathname === '/drive/v3/files' && (options.method || 'GET') === 'GET') {
      return Response.json({ files: state.metadata ? [{ id: FILE, appProperties: state.metadata.appProperties, parents: [FOLDER] }] : [] });
    }
    if (u.pathname === '/upload/drive/v3/files') {
      state.uploads++;
      const body = await options.body.text();
      const match = body.match(/Content-Type: application\/json; charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--metro-post-office-/);
      assert.ok(match);
      state.metadata = JSON.parse(match[1]);
      state.bytes = encoder.encode('hello Metropolis Post Office\n');
      return Response.json({ id: FILE });
    }
    if (u.pathname === '/drive/v3/files/' + FILE && u.searchParams.get('alt') === 'media') {
      return new Response(state.corrupt ? encoder.encode('TAMPERED') : state.bytes,
        { headers: { 'content-type': 'text/plain' } });
    }
    if (u.pathname === '/drive/v3/files/' + FILE) {
      return Response.json({ id: FILE, trashed: false, mimeType: state.metadata.mimeType,
        parents: [FOLDER], appProperties: state.metadata.appProperties });
    }
    throw new Error('UNEXPECTED_URL:' + u.pathname);
  };
  const runtime = createDriveStationRuntime({
    bucket, clientId: 'test-client', clientSecret: 'test-secret',
    refreshToken: 'test-refresh', folderId: FOLDER,
    sourceSha: 'a'.repeat(40), fetchImpl, now: () => '2026-10-08T00:00:00Z',
  });
  const pass = createWorkPass({ workId: WORK, checkpointId: CP, actor: 'GO' });
  const payload = { payloadRef: REF, workPass: pass, workPassRef: workPassRef(pass) };
  const handoff = () => runtime.handoff({ workId: WORK, checkpointId: CP, actor: 'GO',
    operation: 'ARCHIVE_DATA', payload });
  return { runtime, payload, pass, handoff, state };
}

test('unconfigured Drive station fails closed without contacting provider', async () => {
  const runtime = createDriveStationRuntime({});
  assert.equal(runtime.configured, false);
  await assert.rejects(runtime.handoff({ operation: 'ARCHIVE_DATA' }), /DRIVE_STATION_NOT_CONFIGURED/);
  assert.equal(STATION_PLAN_V1.stations.find(s => s.stationId === 'DRIVE_STATION').runtimeBinding, null);
  assert.equal(stationPlanForRuntime({ driveConfigured: true }).stations.find(s => s.stationId === 'DRIVE_STATION').runtimeBinding.verified, false);
});

test('GO scoped Work archives bytes and proves Google Drive readback; never deletes R2', async () => {
  const h = harness();
  assert.equal(h.runtime.configured, true);
  const remote = await h.handoff();
  assert.equal(remote.verified, true);
  assert.equal(remote.providerVerified, true);
  assert.equal(remote.workId, WORK);
  assert.equal(remote.checkpointId, CP);
  assert.equal(remote.workPassRef, workPassRef(h.pass));
  assert.equal(remote.sourceRef, REF);
  assert.equal(remote.sourcePreserved, true);
  assert.equal(remote.receiptId, 'GOOGLE_DRIVE:' + FILE);
  assert.equal(h.state.uploads, 1);
  const readback = await h.runtime.readback({ workId: WORK, checkpointId: CP,
    handoff: { stationId: 'DRIVE_STATION', workPassRef: remote.workPassRef, external: remote } });
  assert.equal(readback.verified, true);
  assert.equal(readback.domainVerified, true);
  assert.equal(readback.result.artifactRefs[0], 'https://drive.google.com/file/d/' + FILE + '/view');
  assert.equal(h.state.deleted, false);
});

test('repeating identical Work archive reuses Drive receipt without duplicate upload', async () => {
  const h = harness();
  const a = await h.handoff();
  const b = await h.handoff();
  assert.equal(a.receiptId, b.receiptId);
  assert.equal(h.state.uploads, 1);
});

test('cross-Work and unauthorized actor cannot read R2 or use Google tokens', async () => {
  const h = harness();
  await assert.rejects(h.runtime.handoff({ workId: 'OTHER', checkpointId: CP, actor: 'GO',
    operation: 'ARCHIVE_DATA', payload: h.payload }), /DRIVE_WORK_PASS_NOT_GRANTED/);
  await assert.rejects(h.runtime.handoff({ workId: WORK, checkpointId: CP, actor: 'LIGHT',
    operation: 'ARCHIVE_DATA', payload: h.payload }), /DRIVE_WORK_PASS_NOT_GRANTED/);
  await assert.rejects(h.runtime.handoff({ workId: WORK, checkpointId: CP, actor: 'GO',
    operation: 'ARCHIVE_DATA', payload: { ...h.payload,
      payloadRef: 'r2://factory/metropolis/tablets/OTHER/CP-01/artifact/secret.txt' } }), /DRIVE_SOURCE_OUTSIDE_WORK/);
  await assert.rejects(h.runtime.handoff({ workId: WORK, checkpointId: CP, actor: 'GO',
    operation: 'DELETE_SOURCE', payload: h.payload }), /DRIVE_OPERATION_NOT_ALLOWED/);
  assert.equal(h.state.oauth, 0);
  assert.equal(h.state.sourceReads, 0);
  assert.equal(h.state.deleted, false);
});

test('readback tampering never becomes a successful Drive receipt', async () => {
  const h = harness();
  h.state.corrupt = true;
  await assert.rejects(h.handoff(), /DRIVE_READBACK_MISMATCH/);
  assert.equal(h.state.deleted, false);
});

test('City Post Office records Drive outbound receipt only after provider proof', async () => {
  const h = harness();
  const city = createCityRuntime({
    store: createMemoryStore(),
    stationRuntimes: { DRIVE_STATION: h.runtime },
    clock: () => '2026-10-08T00:00:00Z',
  });
  const intake = await city.intake({ workId: WORK, checkpointId: CP, ownerSystem: 'FACTORY',
    workPassActor: 'GO', requestedBy: 'GO' });
  assert.equal(intake.workPass.permissions.handoff.some(item => item.stationId === 'DRIVE_STATION'), true);
  const delivered = await city.handoff({ workId: WORK, checkpointId: CP, stationId: 'DRIVE_STATION',
    operation: 'ARCHIVE_DATA', actor: 'GO', payload: { payloadRef: REF } });
  assert.equal(delivered.handoff.external.providerVerified, true);
  assert.equal(delivered.outboundPostal.status, 'DELIVERED');
  assert.equal(delivered.outboundPostal.receipt.receiptId, 'GOOGLE_DRIVE:' + FILE);
  assert.equal(delivered.outboundPostal.route.cargoOnly, true);
  assert.equal(delivered.dataLifecycle.some(item => item.producer === 'POST_OFFICE'), true);
  assert.equal((await city.getWork(WORK)).outboundPostal.status, 'DELIVERED');
  assert.equal(h.state.deleted, false);
});
