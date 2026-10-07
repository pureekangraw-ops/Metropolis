export const MIMIR_RETURN_ROLE = Object.freeze({
  id: 'MIMIR',
  role: 'RETURN_DESK_AND_DATA_ORGANIZER',
  location: 'HALL_RETURN_DESK',
  duties: Object.freeze(['RECEIVE_TABLET', 'ASK_FOR_UPDATE', 'CONFIRM_RETURN', 'ORGANIZE_RETURN_DATA']),
  ownsWorkTruth: false,
  mayApprove: false,
  mayCreateAuthority: false,
});

export const RETURN_CONFIRMATION = 'CONFIRM_RETURN';

const text = value => String(value ?? '').trim();
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
const clone = value => value == null ? value : structuredClone(value);

function normalizeUpdates(updates = []) {
  return (Array.isArray(updates) ? updates : [])
    .filter(item => item && typeof item === 'object' && !Array.isArray(item))
    .map(item => Object.freeze({
      kind: text(item.kind).toUpperCase() || 'NOTE',
      valueRef: text(item.valueRef || item.ref || item.value),
      note: text(item.note) || null,
    }))
    .filter(item => item.valueRef || item.note);
}

export function prepareMimirReturn({
  workId,
  checkpointId,
  readback = null,
  evidenceRefs = [],
  updates = [],
  confirmation = null,
  observedAt = new Date().toISOString(),
} = {}) {
  const packet = Object.freeze({
    workId: text(workId),
    checkpointId: text(checkpointId),
    readback: clone(readback),
    evidenceRefs: Object.freeze(unique(evidenceRefs)),
    updates: Object.freeze(normalizeUpdates(updates)),
    observedAt,
  });

  if (confirmation !== RETURN_CONFIRMATION) {
    return Object.freeze({
      staff: MIMIR_RETURN_ROLE,
      status: 'CONFIRMATION_REQUIRED',
      question: 'ANY_UPDATE_BEFORE_RETURN',
      confirmationRequired: RETURN_CONFIRMATION,
      packet,
      authorityChanged: false,
    });
  }

  return Object.freeze({
    staff: MIMIR_RETURN_ROLE,
    status: 'CONFIRMED',
    question: null,
    confirmationRequired: null,
    packet,
    organized: Object.freeze({
      result: clone(readback),
      evidenceRefs: packet.evidenceRefs,
      updates: packet.updates,
      metadata: Object.freeze({
        workId: packet.workId,
        checkpointId: packet.checkpointId,
        organizedBy: 'MIMIR',
        organizedAt: observedAt,
      }),
    }),
    authorityChanged: false,
  });
}
