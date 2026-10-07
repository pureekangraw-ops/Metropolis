import { createFactoryRailAdapter } from './stations/factory.mjs';

const READY = 'READY';
const FACTORY_STATION_ID = 'FACTORY_STATION';
const FACTORY_EXTERNAL_STATION_ID = 'FACTORY-STATION';
const FACTORY_DOMAINS = new Set(['CODE', 'VISUAL', 'LOGIC']);

function text(value) { return String(value ?? '').trim(); }

function normalizeFactoryExecution(payload = {}) {
  const ownerDomain = text(payload.ownerDomain).toUpperCase();
  if (!FACTORY_DOMAINS.has(ownerDomain)) throw new Error('FACTORY_OWNER_DOMAIN_REQUIRED_OR_INVALID');
  const scope = Array.isArray(payload.scope) ? [...new Set(payload.scope.map(text).filter(Boolean))] : [];
  if (!scope.includes(`EXECUTE:${ownerDomain}`)) throw new Error('FACTORY_SCOPE_REQUIRED');
  return { ownerDomain, scope };
}

export function createFactoryStationRuntime({ baseUrl, sharedSecret, fetchImpl = fetch } = {}) {
  if (!text(baseUrl) || !text(sharedSecret)) {
    return Object.freeze({
      async handoff() { throw new Error('FACTORY_STATION_NOT_CONFIGURED'); },
      async readback() { throw new Error('FACTORY_STATION_NOT_CONFIGURED'); },
    });
  }

  const adapter = createFactoryRailAdapter({ baseUrl, sharedSecret, fetchImpl });
  const station = Object.freeze({ stationId: FACTORY_STATION_ID, ownerSystem: 'FACTORY' });
  const rail = Object.freeze({ railId: 'RAIL_FACTORY' });

  async function handoff({ workId, checkpointId, operation, payload = {} } = {}) {
    const probe = await adapter.probe({ station, rail });
    if (probe.status !== READY) throw new Error('FACTORY_STATION_NOT_READY');
    const sourceSha = text(probe.runtime?.sourceSha);
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error('FACTORY_SOURCE_SHA_UNVERIFIED');
    const execution = normalizeFactoryExecution(payload);

    const transportPayload = {
      ...payload,
      ownerDomain: execution.ownerDomain,
      scope: execution.scope,
      workId,
      checkpointId,
      expectedSourceSha: sourceSha,
      requestedResult: text(payload.requestedResult) || text(payload.intent) || text(operation) || 'FACTORY_HANDOFF',
      source: { stationId: 'METROPOLIS-STATION', system: 'METROPOLIS' },
      target: { stationId: FACTORY_EXTERNAL_STATION_ID, system: 'FACTORY', component: 'FACTORY_HALL' },
    };

    const transport = { payload: transportPayload };
    const receipt = await adapter.dispatch({ transport });
    const readback = await adapter.readback({ receipt, transport });
    if (!readback.verified) throw new Error('FACTORY_BOUNDARY_READBACK_FAILED');

    return Object.freeze({
      verified: true,
      boundaryVerified: true,
      receiptId: receipt.receiptId,
      evidenceRef: readback.evidenceRef,
      sourceSha,
      transportPayload,
      observedAt: readback.observedAt,
    });
  }

  async function readback({ handoff } = {}) {
    const external = handoff?.external;
    if (!external?.receiptId || !external?.transportPayload) throw new Error('FACTORY_HANDOFF_RECEIPT_MISSING');
    const receipt = { receiptId: external.receiptId };
    const transport = { payload: external.transportPayload };
    const result = await adapter.readback({ receipt, transport });
    return Object.freeze({
      ...result,
      verified: result.verified === true,
      domainVerified: result.domainVerified === true,
    });
  }

  return Object.freeze({ handoff, readback });
}
