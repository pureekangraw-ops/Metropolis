const READY = 'READY';
export const FACTORY_STATION_PROTOCOL = 'METROPOLIS_FACTORY_STATION_V2';
export const FACTORY_BRANCH_PROFILE = Object.freeze({
  branchId:'FACTORY_BRANCH', stationId:'FACTORY_STATION', destinationId:'FACTORY',
  preflight:'FACTORY_HEALTH', returnInspection:'DWARF_VERIFY',
});

const text = value => String(value ?? '').trim();

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function signHmac({ body, secret, timestamp }) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  ));
}

export function createFactoryRailAdapter({
  baseUrl,
  sharedSecret,
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
  epochMs = () => Date.now(),
} = {}) {
  const origin = String(baseUrl || '').replace(/\/$/, '');
  if (!origin) throw new TypeError('factory_baseUrl_REQUIRED');
  if (!text(sharedSecret)) throw new TypeError('factory_sharedSecret_REQUIRED');

  async function signedHeaders(body = '') {
    const timestamp = String(epochMs());
    return {
      'x-metropolis-factory-protocol': FACTORY_STATION_PROTOCOL,
      'x-metropolis-factory-timestamp': timestamp,
      'x-metropolis-factory-signature': await signHmac({ body, secret: sharedSecret, timestamp }),
    };
  }

  async function probe({ station, rail }) {
    const response = await fetchImpl(`${origin}/health`);
    const health = await response.json().catch(() => ({}));
    const ready = response.ok && health.status === READY && health.storage?.status === READY && health.transport?.status === READY;
    return {
      status: ready ? READY : 'UNKNOWN',
      identity: { stationId: station.stationId, railId: rail.railId, ownerSystem: station.ownerSystem },
      branchProfile: FACTORY_BRANCH_PROFILE,
      scope: ['FACTORY_HANDOFF'],
      capabilities: { FACTORY_HANDOFF: { status: ready ? READY : 'UNKNOWN', reason: ready ? 'FACTORY_HEALTH_READY' : 'FACTORY_HEALTH_UNVERIFIED' } },
      connectivity: { status: response.ok ? READY : 'UNKNOWN', httpStatus: response.status },
      readback: { supported: true },
      observedAt: health.observedAt || now(),
      runtime: health,
    };
  }

  async function preflight({ transport }) {
    const payload = transport?.payload || {};
    const bodyText = JSON.stringify(payload);
    const response = await fetchImpl(`${origin}/station/preflight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...await signedHeaders(bodyText) },
      body: bodyText,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.allowed !== true) {
      const code = typeof body.reason === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(body.reason)
        ? body.reason : 'FACTORY_PREFLIGHT_UNAVAILABLE';
      throw Object.assign(new Error(code), { stage: 'AUTH', code });
    }
    if (!payload.workId || body.workId !== payload.workId
      || !payload.checkpointId || body.checkpointId !== payload.checkpointId
      || !payload.workPassRef || body.workPassRef !== payload.workPassRef
      || !payload.actingActor || body.actingActor !== payload.actingActor
      || !payload.operation || body.operation !== payload.operation
      || !payload.expectedSourceSha || body.sourceSha !== payload.expectedSourceSha
      || body.validationScope !== 'FACTORY_BOUNDARY_PREFLIGHT') {
      throw Object.assign(new Error('FACTORY_PREFLIGHT_CORRELATION_FAILED'), {
        stage: 'AUTH', code: 'FACTORY_PREFLIGHT_CORRELATION_FAILED',
      });
    }
    return Object.freeze({
      allowed: true, validationScope: body.validationScope,
      observedAt: body.observedAt || now(),
    });
  }

  async function dispatch({ transport }) {
    const bodyText = JSON.stringify(transport.payload || {});
    const response = await fetchImpl(`${origin}/station/receive`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...await signedHeaders(bodyText) },
      body: bodyText,
    });
    const body = await response.json().catch(() => ({}));
    const receiptId = body.receipt?.receiptId || body.readback?.receiptId || null;
    if (!response.ok || !receiptId) {
      throw Object.assign(new Error('FACTORY_HANDOFF_NOT_ACCEPTED'), { stage: 'DESTINATION', code: `FACTORY_HTTP_${response.status}` });
    }
    return {
      accepted: true,
      receiptId,
      providerRef: `${origin}/station/readback/${encodeURIComponent(receiptId)}`,
      response: body,
      acceptedAt: now(),
    };
  }

  async function readback({ receipt, transport }) {
    const response = await fetchImpl(
      `${origin}/station/readback/${encodeURIComponent(receipt.receiptId)}`,
      { headers: await signedHeaders('') },
    );
    const body = await response.json().catch(() => ({}));
    const payload = transport?.payload;
    const correlated = payload?.workId && payload?.checkpointId
      && body.workId === payload.workId && body.checkpointId === payload.checkpointId
      && body.stationId === 'FACTORY-STATION'
      && Boolean(payload.expectedSourceSha) && body.sourceSha === payload.expectedSourceSha;
    const passCorrelated = Boolean(
      payload?.workPassRef
      && body.workPassRef === payload.workPassRef
      && (!body.domainVerified || body.result?.workPassRef === payload.workPassRef)
    );
    const actorCorrelated = !payload?.actingActor || body.actingActor === payload.actingActor;
    const verified = Boolean(
      actorCorrelated
      && response.ok
      && body.receiptId === receipt.receiptId
      && body.boundaryVerified === true
      && body.evidenceRef
      && correlated
      && passCorrelated
    );
    return {
      ...body,
      verified,
      evidenceRef: verified ? body.evidenceRef : null,
      observedAt: body.observedAt || now(),
    };
  }

  return Object.freeze({ profile: FACTORY_BRANCH_PROFILE, probe, preflight, dispatch, readback });
}
