import { createOathRequest, advanceOath, failOath, OATH_STATE } from './oath.mjs';

export const STATION_STATUS = Object.freeze({
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  DENIED: 'DENIED',
  EXPIRED: 'EXPIRED',
  UNAVAILABLE: 'UNAVAILABLE',
  UNKNOWN: 'UNKNOWN',
});

const DISPATCHABLE = new Set([STATION_STATUS.READY, STATION_STATUS.DEGRADED]);

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`);
  return value.trim();
}

function makeFailure(stage, code, message = '') {
  return { stage, code, message: String(message) };
}

function normalizeCapabilities(snapshot) {
  if (snapshot.capabilities && typeof snapshot.capabilities === 'object') return snapshot.capabilities;
  return Object.fromEntries((snapshot.scope || []).map((operation) => [operation, { status: 'READY', reason: 'SCOPE_DECLARED' }]));
}

function normalizeSnapshot(entry, snapshot = {}) {
  const status = snapshot.status || STATION_STATUS.UNKNOWN;
  return Object.freeze({
    status,
    identity: snapshot.identity || { stationId: entry.station.stationId, railId: entry.station.railId, ownerSystem: entry.station.ownerSystem },
    credential: { configured: Boolean(entry.station.credentialRef), reference: entry.station.credentialRef },
    scope: snapshot.scope || [],
    capabilities: normalizeCapabilities(snapshot),
    connectivity: snapshot.connectivity || { status: STATION_STATUS.UNKNOWN },
    limit: snapshot.limit || { status: 'UNKNOWN' },
    readback: snapshot.readback || { supported: false },
    observedAt: snapshot.observedAt || null,
  });
}

function railCapability(snapshot, operation) {
  return snapshot.capabilities?.[operation] || { status: STATION_STATUS.UNKNOWN, reason: 'CAPABILITY_UNVERIFIED' };
}

function outcomeForRailCapability(capability) {
  return capability.status === STATION_STATUS.UNKNOWN ? 'UNKNOWN' : 'FAILED';
}

export function createConnectionEngine({ clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), authorizer } = {}) {
  if (typeof authorizer !== 'function') throw new TypeError('authorizer_REQUIRED');
  const stations = new Map();

  function registerStation({ station, rail, adapter }) {
    if (!station || !rail || !adapter) throw new TypeError('station_rail_adapter_REQUIRED');
    if (station.stationId === undefined || rail.railId === undefined) throw new TypeError('station_rail_ID_REQUIRED');
    if (station.railId !== rail.railId || rail.stationId !== station.stationId) throw new Error('STATION_RAIL_ONE_TO_ONE_REQUIRED');
    if (station.ownerSystem !== rail.ownerSystem) throw new Error('STATION_RAIL_OWNER_MISMATCH');
    if (typeof adapter.probe !== 'function' || typeof adapter.dispatch !== 'function' || typeof adapter.readback !== 'function') {
      throw new TypeError('adapter_probe_dispatch_readback_REQUIRED');
    }
    if (stations.has(station.stationId)) throw new Error('STATION_ALREADY_REGISTERED');
    stations.set(station.stationId, Object.freeze({ station, rail, adapter }));
    return station.stationId;
  }

  async function inspectStation(stationId) {
    const entry = stations.get(requiredString(stationId, 'stationId'));
    if (!entry) return { status: STATION_STATUS.UNKNOWN, failure: makeFailure('STATION', 'STATION_NOT_REGISTERED') };
    try {
      return normalizeSnapshot(entry, await entry.adapter.probe({ station: entry.station, rail: entry.rail }));
    } catch (error) {
      return normalizeSnapshot(entry, { status: STATION_STATUS.UNKNOWN, connectivity: { status: STATION_STATUS.UNKNOWN, error: error.code || error.message } });
    }
  }

  async function travel({ actor, workId, stationId, operation, payload = {} }) {
    const request = {
      actor: requiredString(actor, 'actor'),
      workId: requiredString(workId, 'workId'),
      stationId: requiredString(stationId, 'stationId'),
      operation: requiredString(operation, 'operation'),
      payload,
    };
    const entry = stations.get(request.stationId);
    const oathId = idFactory();
    let oath = createOathRequest({ oathId, ...request, railId: entry?.rail?.railId || 'UNKNOWN', requestedAt: clock() });
    const trace = [{ state: OATH_STATE.REQUEST, at: oath.timestamps.requestedAt }];
    let stage = 'STATION';

    if (!entry) {
      const failure = makeFailure('STATION', 'STATION_NOT_REGISTERED');
      oath = failOath(oath, failure, clock());
      return { outcome: 'UNKNOWN', oath, trace, failure };
    }

    try {
      const stationSnapshot = normalizeSnapshot(entry, await entry.adapter.probe({ station: entry.station, rail: entry.rail }));
      trace.push({ stage: 'STATION', status: stationSnapshot.status, at: stationSnapshot.observedAt || clock() });
      if (!DISPATCHABLE.has(stationSnapshot.status)) {
        const failure = makeFailure('STATION', `STATION_${stationSnapshot.status}`, 'Station is not dispatchable');
        oath = failOath(oath, failure, clock());
        return { outcome: stationSnapshot.status === STATION_STATUS.UNKNOWN ? 'UNKNOWN' : 'FAILED', oath, trace, station: stationSnapshot, failure };
      }

      stage = 'RAIL';
      const identity = stationSnapshot.identity || {};
      if (identity.stationId !== entry.station.stationId || identity.railId !== entry.rail.railId || identity.ownerSystem !== entry.station.ownerSystem) {
        const failure = makeFailure('RAIL', 'RAIL_IDENTITY_MISMATCH', 'Runtime identity does not match the registered Station/Rail pair');
        oath = failOath(oath, failure, clock());
        return { outcome: 'FAILED', oath, trace, station: stationSnapshot, failure };
      }
      const capability = railCapability(stationSnapshot, request.operation);
      if (capability.status !== STATION_STATUS.READY) {
        const failure = makeFailure('RAIL', `RAIL_CAPABILITY_${capability.status}`, capability.reason || 'Rail capability is not verified');
        oath = failOath(oath, failure, clock());
        return { outcome: outcomeForRailCapability(capability), oath, trace, station: stationSnapshot, failure };
      }

      stage = 'AUTH';
      const decision = await authorizer(request);
      if (!decision?.allowed) {
        const failure = makeFailure('AUTH', decision?.reason || 'DENIED', 'Agent is not authorized for this Station and Work');
        oath = failOath(oath, failure, clock());
        return { outcome: 'FAILED', oath, trace, station: stationSnapshot, failure };
      }
      oath = advanceOath(oath, OATH_STATE.ACCEPTED, { timestamps: { ...oath.timestamps, acceptedAt: clock() } });
      trace.push({ state: oath.state, at: oath.timestamps.acceptedAt });

      stage = 'TRANSPORT';
      oath = advanceOath(oath, OATH_STATE.DISPATCHED, { timestamps: { ...oath.timestamps, dispatchedAt: clock() } });
      trace.push({ state: oath.state, at: oath.timestamps.dispatchedAt });
      const receipt = await entry.adapter.dispatch({ oath: { ...oath, payload: request.payload }, station: entry.station, rail: entry.rail });
      if (!receipt?.accepted) throw Object.assign(new Error('RECEIPT_NOT_ACCEPTED'), { code: 'RECEIPT_NOT_ACCEPTED' });
      oath = advanceOath(oath, OATH_STATE.RECEIPT, { receipt, timestamps: { ...oath.timestamps, receiptAt: clock() } });
      trace.push({ state: oath.state, at: oath.timestamps.receiptAt });

      stage = 'READBACK';
      const readback = await entry.adapter.readback({ oath: { ...oath, payload: request.payload }, receipt, station: entry.station, rail: entry.rail });
      oath = advanceOath(oath, OATH_STATE.READBACK, {
        readback,
        evidenceRef: readback?.evidenceRef || null,
        timestamps: { ...oath.timestamps, readbackAt: clock() },
      });
      trace.push({ state: oath.state, at: oath.timestamps.readbackAt });
      if (readback?.verified !== true || !readback.evidenceRef) {
        return { outcome: 'UNKNOWN', oath, trace, station: stationSnapshot, failure: makeFailure('READBACK', 'READBACK_NOT_VERIFIED', 'Receipt exists but live readback is not verified') };
      }
      return { outcome: 'VERIFIED', oath, trace, station: stationSnapshot };
    } catch (error) {
      const failure = makeFailure(error.stage || stage, error.code || 'TRANSPORT_ERROR', error.message);
      if (oath.state !== OATH_STATE.FAILED) oath = failOath(oath, failure, clock());
      return { outcome: failure.stage === 'STATION' ? 'UNKNOWN' : 'FAILED', oath, trace, failure };
    }
  }

  return Object.freeze({ registerStation, inspectStation, travel });
}
