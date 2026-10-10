import { createFactoryRailAdapter } from './stations/factory.mjs';

const READY = 'READY';
const FACTORY_STATION_ID = 'FACTORY_STATION';
const FACTORY_EXTERNAL_STATION_ID = 'FACTORY-STATION';

function text(value) { return String(value ?? '').trim(); }

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
    if (probe.status !== READY) throw Object.assign(new Error('FACTORY_STATION_NOT_READY'),{notSent:true});
    const sourceSha = text(probe.runtime?.sourceSha);
    if (!/^[a-f0-9]{40}$/.test(sourceSha)) throw Object.assign(new Error('FACTORY_SOURCE_SHA_UNVERIFIED'),{notSent:true});

    const transportPayload = {
      ...payload,
      workId,
      checkpointId,
      operation: text(operation) || 'FACTORY_HANDOFF',
      expectedSourceSha: sourceSha,
      requestedResult: text(payload.requestedResult) || text(payload.intent) || text(operation) || 'FACTORY_HANDOFF',
      source: { stationId: 'METROPOLIS-STATION', system: 'METROPOLIS' },
      target: { stationId: FACTORY_EXTERNAL_STATION_ID, system: 'FACTORY', component: 'FACTORY_HALL' },
    };

    const transport = { payload: transportPayload };
    // Authenticate and validate the exact Work Pass at Factory before dispatch.
    // A failed preflight must not alter City Work or create a Factory receipt.
    try { await adapter.preflight({ transport }); }
    catch(error){throw Object.assign(error,{notSent:true});}
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
