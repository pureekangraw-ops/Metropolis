import { hash, json } from './shared-mcp.mjs';

const STATION_ID = 'OBSERVATORY_STATION';
const MAX_SNAPSHOT_BYTES = 48 * 1024;
const MAX_AGE_MS = 30_000;
const MAX_FUTURE_MS = 5_000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(reason) {
  throw new Error(reason);
}

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function rejectSecrets(value, depth = 0) {
  if (depth > 16) fail('PAYLOAD_TOO_DEEP');
  if (Array.isArray(value)) {
    for (const item of value) rejectSecrets(item, depth + 1);
    return;
  }
  if (!isObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(authorization|cookie|password|passcode|token|apiKey|clientSecret|secret)$/i.test(key)) {
      fail('SECRET_FIELD_DENIED');
    }
    if (/^(actor|checkpointId|railId|rendererId|schemaHash|stationId|workId)$/i.test(key)) {
      fail('CALLER_CONTEXT_DENIED');
    }
    rejectSecrets(child, depth + 1);
  }
}

function redactString(value) {
  return String(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {
        const url = new URL(raw);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
      } catch {
        return '[REDACTED_URL]';
      }
    })
    .replace(/\b(Bearer\s+)[\w.-]+/gi, '$1[REDACTED]')
    .replace(/\b(password|passcode|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redact(child)]));
  return value;
}

function validateSnapshot(view, input) {
  if (!isObject(input)) fail('SNAPSHOT_INVALID');
  const expectedSchema = view === 'browser' ? 'observer.snapshot.v1' : 'observatory.map.snapshot.v1';
  if (input.schema !== expectedSchema
    || typeof input.captureId !== 'string'
    || !input.captureId.trim()
    || input.captureId.length > 128
    || !Number.isSafeInteger(input.capturedAtEpochMs)
    || !Number.isSafeInteger(input.sequence)
    || input.sequence < 0
    || !Number.isSafeInteger(input.epoch)
    || input.epoch < 0
    || !Number.isSafeInteger(input.revision)
    || input.revision < 0) fail('SNAPSHOT_INVALID');
  if (view === 'browser') {
    if (typeof input.text !== 'string'
      || new TextEncoder().encode(input.text).length > 32 * 1024
      || typeof input.url !== 'string'
      || typeof input.title !== 'string'
      || typeof input.tabId !== 'string'
      || !Array.isArray(input.targets)
      || input.targets.length > 300
      || typeof input.truncated !== 'boolean') fail('SNAPSHOT_INVALID');
  } else if (!isObject(input.state)
    || !['zones', 'grids', 'pins', 'notes'].every(key => Array.isArray(input.state[key]))) {
    fail('SNAPSHOT_INVALID');
  }

  rejectSecrets(input);
  const safe = redact(structuredClone(input));
  if (bytes(safe) > MAX_SNAPSHOT_BYTES) fail('PAYLOAD_TOO_LARGE');
  return safe;
}

export function createObservatoryStation({ env = {}, storage, runtime, clock = () => Date.now() } = {}) {
  if (!storage?.get || !storage?.put || !runtime?.getWork) fail('STATION_DEPENDENCIES_REQUIRED');
  const origin = String(env.MCP_PUBLIC_ORIGIN || '');
  const workKey = workId => `observatory:work:${workId}`;
  const snapshotKey = (workId, view) => `observatory:snapshot:${workId}:${view}`;
  const receiptKey = receiptId => `metropolis:station-receipt:${receiptId}`;
  const sessionKey = deviceId => `observatory:device:${deviceId}`;

  async function boundWork(actor, workId, checkpointId = null) {
    if (actor !== 'GO') fail('GO_REQUIRED');
    const work = await runtime.getWork(workId);
    if (!work) fail('WORK_NOT_FOUND');
    if (work.ownerSystem !== 'OBSERVATORY') fail('WORK_OWNER_MISMATCH');
    if (checkpointId && work.checkpointId !== checkpointId) fail('CHECKPOINT_MISMATCH');
    if (['CANCELLED', 'COMPLETED'].includes(String(work.state || '').toUpperCase())) fail('WORK_CLOSED');
    return work;
  }

  async function pair({ actor, workId } = {}) {
    const work = await boundWork(actor, workId);
    const previousLink = await storage.get(workKey(work.workId));
    if (previousLink?.deviceId) {
      const previous = await storage.get(sessionKey(previousLink.deviceId));
      if (previous) await storage.put(sessionKey(previousLink.deviceId), { ...previous, active: false, tokenHash: null });
    }
    for (const view of ['browser', 'map']) {
      const key = snapshotKey(work.workId, view);
      if (storage.delete) await storage.delete(key);
      else await storage.put(key, null);
    }
    const deviceId = crypto.randomUUID();
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2, '0')).join('');
    const session = {
      deviceId,
      actor,
      workId: work.workId,
      checkpointId: work.checkpointId,
      tokenHash: await hash(token),
      pairedAtEpochMs: clock(),
      active: true,
    };
    await storage.put(sessionKey(deviceId), session);
    await storage.put(workKey(work.workId), { deviceId });
    return {
      deviceId,
      token,
      publishSnapshot: `${origin}/observatory/device/${deviceId}/snapshot`,
      expiresWhenWorkCloses: true,
    };
  }

  async function sessionFor(deviceId, token) {
    if (!UUID.test(deviceId) || typeof token !== 'string' || !token) fail('AUTH_REQUIRED');
    const session = await storage.get(sessionKey(deviceId));
    if (!session?.active || !session.tokenHash || await hash(token) !== session.tokenHash) fail('AUTH_REQUIRED');
    const work = await boundWork(session.actor, session.workId, session.checkpointId);
    return { session, work };
  }

  async function publish({ deviceId, token, view, snapshot } = {}) {
    if (!['browser', 'map'].includes(view)) fail('VIEW_INVALID');
    const { session } = await sessionFor(deviceId, token);
    const safeSnapshot = validateSnapshot(view, snapshot);
    const now = clock();
    if (safeSnapshot.capturedAtEpochMs > now + MAX_FUTURE_MS
      || safeSnapshot.capturedAtEpochMs < now - MAX_AGE_MS) fail('STALE_CAPTURE');
    const old = await storage.get(snapshotKey(session.workId, view));
    if (old?.snapshot) {
      if (safeSnapshot.captureId === old.snapshot.captureId) {
        if (JSON.stringify(safeSnapshot) !== JSON.stringify(old.snapshot)) fail('DUPLICATE_CHANGED');
        return {
          accepted: true,
          stationId: STATION_ID,
          operation: 'observe',
          captureId: safeSnapshot.captureId,
          sequence: safeSnapshot.sequence,
          businessOutcome: 'UNKNOWN',
        };
      }
      if (safeSnapshot.epoch < old.snapshot.epoch
        || (safeSnapshot.epoch === old.snapshot.epoch && safeSnapshot.sequence <= old.snapshot.sequence)) fail('SNAPSHOT_REPLAY');
    }
    const record = {
      stationId: STATION_ID,
      operation: 'observe',
      workId: session.workId,
      checkpointId: session.checkpointId,
      actor: session.actor,
      deviceId: session.deviceId,
      view,
      snapshot: safeSnapshot,
      acceptedAtEpochMs: now,
    };
    await storage.put(snapshotKey(session.workId, view), record);
    const readback = await storage.get(snapshotKey(session.workId, view));
    if (JSON.stringify(readback) !== JSON.stringify(record)) fail('WRITE_READBACK_MISMATCH');
    return {
      accepted: true,
      stationId: STATION_ID,
      operation: 'observe',
      captureId: safeSnapshot.captureId,
      sequence: safeSnapshot.sequence,
      businessOutcome: 'UNKNOWN',
    };
  }

  async function observe({ actor, workId, checkpointId, view } = {}) {
    const work = await boundWork(actor, workId, checkpointId);
    if (!['browser', 'map'].includes(view)) fail('VIEW_INVALID');
    const link = await storage.get(workKey(work.workId));
    if (!link?.deviceId) fail('DEVICE_NOT_PAIRED');
    const session = await storage.get(sessionKey(link.deviceId));
    if (!session?.active || session.actor !== actor || session.checkpointId !== work.checkpointId) fail('DEVICE_NOT_PAIRED');
    const current = await storage.get(snapshotKey(work.workId, view));
    if (!current || current.stationId !== STATION_ID
      || current.workId !== work.workId
      || current.checkpointId !== work.checkpointId
      || current.actor !== actor
      || current.deviceId !== session.deviceId
      || current.view !== view) fail('READBACK_CONTEXT_MISMATCH');
    const snapshot = current.snapshot;
    const observedAtEpochMs = clock();
    if (observedAtEpochMs - snapshot.capturedAtEpochMs > MAX_AGE_MS
      || snapshot.capturedAtEpochMs > observedAtEpochMs + MAX_FUTURE_MS) fail('STALE_CAPTURE');

    const receiptId = crypto.randomUUID();
    const receipt = {
      kind: 'METROPOLIS_STATION_RECEIPT_V1',
      receiptId,
      stationId: STATION_ID,
      operation: 'observe',
      actor,
      workId: work.workId,
      checkpointId: work.checkpointId,
      view,
      captureId: snapshot.captureId,
      sequence: snapshot.sequence,
      snapshotHash: await hash(JSON.stringify(snapshot)),
      observedAt: new Date(observedAtEpochMs).toISOString(),
      status: 'READBACK_VERIFIED',
      businessOutcome: 'UNKNOWN',
    };
    await storage.put(receiptKey(receiptId), receipt);
    const receiptReadback = await storage.get(receiptKey(receiptId));
    if (JSON.stringify(receiptReadback) !== JSON.stringify(receipt)) fail('RECEIPT_READBACK_MISMATCH');
    return {
      stationId: STATION_ID,
      operation: 'observe',
      snapshot,
      receipt: receiptReadback,
      readbackVerified: true,
      businessOutcome: 'UNKNOWN',
    };
  }

  async function disconnect({ deviceId, token } = {}) {
    const { session } = await sessionFor(deviceId, token);
    await storage.put(sessionKey(deviceId), { ...session, active: false, tokenHash: null });
    const link = await storage.get(workKey(session.workId));
    if (link?.deviceId === deviceId) {
      if (storage.delete) await storage.delete(workKey(session.workId));
      else await storage.put(workKey(session.workId), null);
      for (const view of ['browser', 'map']) {
        const key = snapshotKey(session.workId, view);
        if (storage.delete) await storage.delete(key);
        else await storage.put(key, null);
      }
    }
    return { disconnected: true, stationId: STATION_ID };
  }

  async function fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== origin) return json({ reason: 'ORIGIN_MISMATCH' }, 403);
    const match = url.pathname.match(/^\/observatory\/device\/([a-f0-9-]{36})\/(snapshot|disconnect)$/i);
    if (!match) return json({ reason: 'ROUTE_NOT_FOUND' }, 404);
    if (request.method !== 'POST') return json({ reason: 'METHOD_NOT_ALLOWED' }, 405);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ reason: 'CONTENT_TYPE_REQUIRED' }, 415);
    try {
      const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!token) fail('AUTH_REQUIRED');
      const raw = await request.text();
      if (new TextEncoder().encode(raw).length > MAX_SNAPSHOT_BYTES + 2048) fail('PAYLOAD_TOO_LARGE');
      const body = JSON.parse(raw);
      if (match[2] === 'disconnect') {
        if (!isObject(body) || Object.keys(body).length !== 0) fail('CALLER_CONTEXT_DENIED');
        return json(await disconnect({ deviceId: match[1], token }));
      }
      const result = await publish({
        deviceId: match[1],
        token,
        view: body?.view,
        snapshot: body?.snapshot,
      });
      return json(result);
    } catch (error) {
      const reasons = new Set([
        'AUTH_REQUIRED', 'WORK_NOT_FOUND', 'WORK_OWNER_MISMATCH', 'CHECKPOINT_MISMATCH',
        'WORK_CLOSED', 'NO_GRANT', 'VIEW_INVALID', 'SNAPSHOT_INVALID',
        'CALLER_CONTEXT_DENIED', 'PAYLOAD_TOO_DEEP', 'SECRET_FIELD_DENIED',
        'PAYLOAD_TOO_LARGE', 'STALE_CAPTURE', 'SNAPSHOT_REPLAY', 'DUPLICATE_CHANGED',
        'WRITE_READBACK_MISMATCH', 'READBACK_CONTEXT_MISMATCH',
      ]);
      return json({ reason: reasons.has(error.message) ? error.message : 'OBSERVATORY_PUBLISH_FAILED' }, 400);
    }
  }

  return Object.freeze({ pair, publish, observe, disconnect, fetch });
}