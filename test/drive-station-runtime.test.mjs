import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriveStationRuntime } from '../src/drive-station-runtime.mjs';
import { createCityRuntime, createMemoryStore } from '../src/city-runtime.mjs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const folderId = 'folder12345';
function bucket() {
  const files = new Map();
  return {
    files,
    async put(key, body, opts = {}) {
      files.set(key, { body: new Uint8Array(body), mimeType: opts.httpMetadata?.contentType || 'text/plain' });
      return { etag: 'etag' };
    },
    async get(key) {
      const record = files.get(key);
      if (!record) return null;
      return {
        size: record.body.byteLength,
        httpMetadata: { contentType: record.mimeType },
        async arrayBuffer() { return record.body.buffer.slice(record.body.byteOffset, record.body.byteOffset + record.body.byteLength); },
      };
    },
  };
}
function google() {
  const files = new Map();
  let nextId = 1;
  let corrupt = false;
  const fetchImpl = async (url, opts = {}) => {
    const target = String(url);
    if (target === 'https://oauth2.googleapis.com/token') {
      assert.equal(opts.method, 'POST');
      assert.equal(new URLSearchParams(opts.body).get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'test-token' });
    }
    assert.equal(opts.headers?.authorization, 'Bearer test-token');
    const parsed = new URL(target);
    if (parsed.pathname === '/drive/v3/files' && opts.method !== 'POST') {
      assert.match(parsed.searchParams.get('q'), /metroCargoKey/);
      return Response.json({ files: [...files.values()].map(file => ({
        id: file.id, parents: file.parents, appProperties: file.appProperties, trashed: false,
      })) });
    }
    if (parsed.pathname === '/upload/drive/v3/files') {
      assert.equal(opts.method, 'POST');
      const boundary = opts.headers['content-type'].split('boundary=')[1];
      const multipart = decoder.decode(opts.body);
      const split = '\r\n--' + boundary + '\r\nContent-Type:';
      const begin = multipart.indexOf('\r\n\r\n') + 4;
      const mid = multipart.indexOf(split, begin);
      const metadata = JSON.parse(multipart.slice(begin, mid));
      const contentBegin = multipart.indexOf('\r\n\r\n', mid) + 4;
      const contentEnd = multipart.indexOf('\r\n--' + boundary + '--', contentBegin);
      const bytes = encoder.encode(multipart.slice(contentBegin, contentEnd));
      const id = 'googleDriveFile' + nextId++;
      files.set(id, { id, bytes, parents: metadata.parents, appProperties: metadata.appProperties });
      return Response.json({ id });
    }
    const path = parsed.pathname.split('/');
    const id = decodeURIComponent(path[path.length - 1]);
    const file = files.get(id);
    if (!file) return Response.json({ error: 'missing' }, { status: 404 });
    if (parsed.searchParams.get('alt') === 'media') {
      return new Response(corrupt ? encoder.encode('TAMPERED') : file.bytes);
    }
    return Response.json({
      id: file.id, trashed: false, parents: file.parents,
      appProperties: file.appProperties,
    });
  };
  return { files, fetchImpl, corrupt: v => { corrupt = v; } };
}
function runtime({ store = bucket(), provider = google(), tokens = true } = {}) {
  return {
    store, provider,
    station: createDriveStationRuntime({
      bucket: store, clientId: tokens ? 'CLIENT' : '',
      clientSecret: tokens ? 'SECRET' : '',
      refreshToken: tokens ? 'REFRESH' : '',
      folderId, fetchImpl: provider.fetchImpl,
    }),
  };
}
function pass(workId, checkpointId, actor = 'GO', stationId = 'DRIVE_STATION') {
  return {
    kind: 'WORK_PASS', version: 'WORK_PASS_V1',
    passId: 'PASS:' + workId + ':' + actor,
    workId, checkpointId, actor, status: 'ACTIVE',
    permissions: { actions: ['handoff'], handoff: [{ stationId }] },
    authorityTransferred: false,
  };
}

test('POST OFFICE stages Work-scoped R2 cargo, Drive uploads, reads back and issues receipt', async () => {
  const { station, store, provider } = runtime();
  const city = createCityRuntime({ store: createMemoryStore(), stationRuntimes: { DRIVE_STATION: station } });
  const original = await city.intake({
    workId: 'WORK-DRIVE', checkpointId: 'CP-01', ownerSystem: 'GOOGLE_DRIVE', workPassActor: 'GO',
  });
  assert.deepEqual(original.workPass.permissions.handoff.map(x => x.stationId), ['DRIVE_STATION']);
  const sent = await city.handoff({
    workId: original.workId, checkpointId: original.checkpointId,
    stationId: 'DRIVE_STATION', operation: 'ARCHIVE_CARGO', actor: 'GO',
    payload: { content: 'metropolis archive smoke', dataKind: 'DATA', fileName: 'proof.txt', mimeType: 'text/plain' },
  });
  assert.equal(sent.handoff.external.verified, true);
  assert.equal(sent.handoff.external.storageVerified, true);
  assert.equal(sent.handoff.postal.status, 'DELIVERED');
  assert.equal(sent.handoff.postal.receipt.kind, 'DELIVERY_RECEIPT');
  assert.equal(sent.handoff.payload.content, undefined);
  assert.match(sent.handoff.payload.payloadRef, /^r2:\/\/factory\/metropolis\/drive\/outbox\/WORK-DRIVE\/CP-01\/proof.txt$/);
  const serialized = JSON.stringify(await city.getWork('WORK-DRIVE'));
  assert.equal(serialized.includes('metropolis archive smoke'), false);
  assert.equal(store.files.size, 1);
  assert.equal(provider.files.size, 1);
  const reviewed = await city.returnWork({ workId: original.workId, checkpointId: original.checkpointId });
  assert.equal(reviewed.stationReturnReview.verified, true);
  assert.equal(reviewed.stationReturnReview.readback.storageVerified, true);
  const returned = await city.returnWork({ workId: original.workId, checkpointId: original.checkpointId, stationReviewed: true });
  assert.equal(returned.state, 'RETURNED');
});

test('Drive upload is idempotent for the same Work/Checkpoint/cargo source', async () => {
  const { station, provider } = runtime();
  const workId = 'WORK-REPLAY', checkpointId = 'CP-02', workPass = pass(workId, checkpointId);
  const a = { workId, checkpointId, operation: 'ARCHIVE_CARGO', actor: 'GO',
    payload: { content: 'repeat', dataKind: 'EVIDENCE', mimeType: 'text/plain', fileName: 'repeat.txt', workPass, workPassRef: 'work-pass://' + workPass.passId } };
  const staged = await station.stage(a);
  const args = { ...a, payload: { ...a.payload, payloadRef: staged.payloadRef } };
  const first = await station.handoff(args);
  const second = await station.handoff(args);
  assert.equal(first.providerFileId, second.providerFileId);
  assert.equal(provider.files.size, 1);
});

test('Drive stops if provider file changes after upload; receipt is not claimed', async () => {
  const { station, provider } = runtime();
  const workId = 'WORK-TAMPER', checkpointId = 'CP-02', workPass = pass(workId, checkpointId);
  const args = { workId, checkpointId, operation: 'ARCHIVE_CARGO', actor: 'LIGHT',
    payload: { content: 'sealed', dataKind: 'EVIDENCE', mimeType: 'text/plain', fileName: 'seal.txt',
      workPass: pass(workId, checkpointId, 'LIGHT'), workPassRef: 'work-pass://' + 'PASS:' + workId + ':LIGHT' } };
  const staged = await station.stage(args);
  provider.corrupt(true);
  await assert.rejects(
    station.handoff({ ...args, payload: { ...args.payload, payloadRef: staged.payloadRef } }),
    /DRIVE_CONTENT_READBACK_MISMATCH/,
  );
});

test('Drive denies missing secrets, wrong Work pass, and foreign R2 object keys', async () => {
  const { station: unconfigured } = runtime({ tokens: false });
  await assert.rejects(unconfigured.handoff({}), /DRIVE_STATION_NOT_CONFIGURED/);
  const { station } = runtime();
  const workId = 'WORK-SAFE', checkpointId = 'CP-01';
  const ownPass = pass(workId, checkpointId);
  const base = { workId, checkpointId, operation: 'ARCHIVE_CARGO', actor: 'GO',
    payload: { dataKind: 'DATA', workPass: ownPass,
      workPassRef: 'work-pass://' + ownPass.passId, content: 'abc',
      fileName: 'proof.txt', mimeType: 'text/plain' } };
  await assert.rejects(
    station.stage({ ...base, actor: 'LIGHT' }),
    /DRIVE_WORK_PASS_DENIED/,
  );
  await assert.rejects(
    station.handoff({ ...base, payload: { ...base.payload,
      payloadRef: 'r2://factory/metropolis/drive/outbox/WORK-FOREIGN/CP-01/proof.txt' } }),
    /DRIVE_CARGO_REF_INVALID/,
  );
});
