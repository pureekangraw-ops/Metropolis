// Transport-only Metropolis <-> Greenhouse station. No new actor identity.
export const GREENHOUSE_PROTOCOL = 'METROPOLIS_GREENHOUSE_STATION_V1';
const nonempty = x => typeof x === 'string' && x.trim().length > 0;

export function createGreenhouseRailAdapter({
  baseUrl, sharedSecret, fetchImpl = fetch, now = () => new Date().toISOString(),
} = {}) {
  if (!nonempty(baseUrl) || !nonempty(sharedSecret)) throw new TypeError('GREENHOUSE_CONNECTION_NOT_CONFIGURED');
  const origin = baseUrl.replace(/\/$/, '');
  if (!origin.startsWith('https://')) throw new TypeError('GREENHOUSE_HTTPS_REQUIRED');
  const headers = () => ({
    'content-type': 'application/json',
    'x-metropolis-greenhouse-protocol': GREENHOUSE_PROTOCOL,
    authorization: `Bearer ${sharedSecret}`,
  });
  const json = async response => response.json().catch(() => ({}));
  return Object.freeze({
    async probe({ station, rail }) {
      const response = await fetchImpl(`${origin}/station/health`, { headers: headers() });
      const body = await json(response);
      const ready = response.ok && body.status === 'READY'
        && body.stationId === station.stationId
        && body.railId === rail.railId
        && body.ownerSystem === station.ownerSystem;
      return {
        status: ready ? 'READY' : 'UNKNOWN',
        identity: { stationId: body.stationId, railId: body.railId, ownerSystem: body.ownerSystem },
        scope: ready ? ['COORDINATE_HANDOFF'] : [],
        capabilities: { COORDINATE_HANDOFF: { status: ready ? 'READY' : 'UNKNOWN' } },
        connectivity: { status: ready ? 'READY' : 'UNKNOWN' },
        readback: { supported: ready },
        observedAt: body.observedAt || now(),
      };
    },
    async dispatch({ transport }) {
      const p = transport.payload || {};
      if (!nonempty(p.workId) || !nonempty(p.checkpointId) || !nonempty(p.targetStation)
        || p.workId !== transport.workId || !nonempty(p.operation)
        || !nonempty(p.workPassRef) || !nonempty(p.actingActor)) {
        throw Object.assign(new Error('GREENHOUSE_WORK_CONTEXT_INVALID'), { code: 'GREENHOUSE_WORK_CONTEXT_INVALID' });
      }
      const response = await fetchImpl(`${origin}/station/receive`, {
        method: 'POST', headers: headers(),
        body: JSON.stringify({
          transportId: transport.transportId, workId: transport.workId,
          checkpointId: p.checkpointId, targetStation: p.targetStation,
          operation: p.operation, workPassRef: p.workPassRef,
          actingActor: p.actingActor, payload: p.payload || {},
        }),
      });
      const body = await json(response);
      if (!response.ok || body.accepted !== true || !nonempty(body.receiptId)
        || body.workId !== p.workId || body.checkpointId !== p.checkpointId) {
        throw Object.assign(new Error('GREENHOUSE_RECEIPT_NOT_ACCEPTED'), { code: 'GREENHOUSE_RECEIPT_NOT_ACCEPTED' });
      }
      return { accepted: true, receiptId: body.receiptId, acceptedAt: now() };
    },
    async readback({ receipt, transport }) {
      const response = await fetchImpl(
        `${origin}/station/readback/${encodeURIComponent(receipt.receiptId)}`,
        { headers: headers() },
      );
      const body = await json(response);
      const p = transport.payload || {};
      const verified = response.ok && body.verified === true
        && body.receiptId === receipt.receiptId
        && body.workId === transport.workId && body.checkpointId === p.checkpointId
        && body.targetStation === p.targetStation && nonempty(body.evidenceRef);
      return { ...body, verified: Boolean(verified), evidenceRef: verified ? body.evidenceRef : null, observedAt: now() };
    },
  });
}
