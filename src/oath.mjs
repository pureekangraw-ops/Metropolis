export const OATH_STATE = Object.freeze({
  REQUEST: 'REQUEST',
  ACCEPTED: 'ACCEPTED',
  DISPATCHED: 'DISPATCHED',
  RECEIPT: 'RECEIPT',
  READBACK: 'READBACK',
  FAILED: 'FAILED',
});

const TRANSITIONS = Object.freeze({
  REQUEST: new Set(['ACCEPTED', 'FAILED']),
  ACCEPTED: new Set(['DISPATCHED', 'FAILED']),
  DISPATCHED: new Set(['RECEIPT', 'FAILED']),
  RECEIPT: new Set(['READBACK', 'FAILED']),
  READBACK: new Set([]),
  FAILED: new Set([]),
});

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`);
  return value.trim();
}

export function createOathRequest({ oathId, workId, actor, stationId, railId, operation, requestedAt }) {
  return Object.freeze({
    kind: 'OATH',
    oathId: requiredString(oathId, 'oathId'),
    workId: requiredString(workId, 'workId'),
    actor: requiredString(actor, 'actor'),
    stationId: requiredString(stationId, 'stationId'),
    railId: requiredString(railId, 'railId'),
    operation: requiredString(operation, 'operation'),
    state: OATH_STATE.REQUEST,
    timestamps: { requestedAt: requiredString(requestedAt, 'requestedAt') },
    receipt: null,
    evidenceRef: null,
    failure: null,
  });
}

export function advanceOath(oath, nextState, patch = {}) {
  if (!oath || !TRANSITIONS[oath.state]?.has(nextState)) {
    throw new Error(`OATH_INVALID_TRANSITION:${oath?.state || 'UNKNOWN'}:${nextState}`);
  }
  return Object.freeze({ ...oath, ...patch, state: nextState });
}

export function failOath(oath, failure, failedAt) {
  return advanceOath(oath, OATH_STATE.FAILED, {
    timestamps: { ...oath.timestamps, failedAt },
    failure: { stage: requiredString(failure.stage, 'failure.stage'), code: requiredString(failure.code, 'failure.code'), message: String(failure.message || '') },
  });
}
