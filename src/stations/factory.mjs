const READY = 'READY';

export function createFactoryRailAdapter({ baseUrl, fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const origin = String(baseUrl || '').replace(/\/$/, '');
  if (!origin) throw new TypeError('factory_baseUrl_REQUIRED');

  async function probe({ station, rail }) {
    const response = await fetchImpl(`${origin}/health`);
    const health = await response.json().catch(() => ({}));
    const ready = response.ok && health.status === READY && health.storage?.status === READY;
    return {
      status: ready ? READY : 'UNKNOWN',
      identity: { stationId: station.stationId, railId: rail.railId, ownerSystem: station.ownerSystem },
      scope: ['FACTORY_HANDOFF'],
      capabilities: { FACTORY_HANDOFF: { status: ready ? READY : 'UNKNOWN', reason: ready ? 'FACTORY_HEALTH_READY' : 'FACTORY_HEALTH_UNVERIFIED' } },
      connectivity: { status: response.ok ? READY : 'UNKNOWN', httpStatus: response.status },
      readback: { supported: true },
      observedAt: health.observedAt || now(),
      runtime: health,
    };
  }

  async function dispatch({ transport }) {
    const response = await fetchImpl(`${origin}/station/receive`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(transport.payload || {}),
    });
    const body = await response.json().catch(() => ({}));
    const receiptId = body.receipt?.receiptId || body.readback?.receiptId || null;
    if (!response.ok || !receiptId) throw Object.assign(new Error('FACTORY_HANDOFF_NOT_ACCEPTED'), { stage: 'DESTINATION', code: `FACTORY_HTTP_${response.status}` });
    return { accepted: true, receiptId, providerRef: `${origin}/station/readback/${encodeURIComponent(receiptId)}`, response: body, acceptedAt: now() };
  }

  async function readback({ receipt }) {
    const response = await fetchImpl(`${origin}/station/readback/${encodeURIComponent(receipt.receiptId)}`);
    const body = await response.json().catch(() => ({}));
    const verified = response.ok && body.receiptId === receipt.receiptId && body.boundaryVerified === true && Boolean(body.evidenceRef);
    return { ...body, verified, evidenceRef: verified ? body.evidenceRef : null, observedAt: body.observedAt || now() };
  }

  return Object.freeze({ probe, dispatch, readback });
}
