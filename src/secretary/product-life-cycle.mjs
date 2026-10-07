export const SECRETARY_PRODUCT_LIFE_CYCLE = Object.freeze({
  id: 'SECRETARY',
  aka: 'PRODUCT_LIFE_CYCLE',
  role: 'HALL_DATA_LIFECYCLE',
  scope: 'ALL_HALL_DATA',
  ownsSourceTruth: false,
  mayRewriteSourceTruth: false,
});

export const DATA_LIFECYCLE_STATUS = Object.freeze({
  CURRENT: 'CURRENT',
  SUPERSEDED: 'SUPERSEDED',
  ARCHIVED: 'ARCHIVED',
});

const text = value => String(value ?? '').trim();
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];
const clone = value => value == null ? value : structuredClone(value);

function stableSlot({ producer, kind, slot }) {
  return text(slot) || `${text(producer).toUpperCase() || 'UNKNOWN'}:${text(kind).toUpperCase() || 'DATA'}`;
}

export function rotateHallData(entries = [], {
  dataId,
  workId,
  checkpointId,
  producer,
  kind = 'DATA',
  payloadRef = null,
  evidenceRefs = [],
  ownerSystem = null,
  truthOwner = null,
  slot = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const nextId = text(dataId);
  if (!nextId) throw new Error('DATA_ID_REQUIRED');
  const nextSlot = stableSlot({ producer, kind, slot });
  const current = (Array.isArray(entries) ? entries : []).map(clone);
  const rotated = current.map(entry => {
    if (entry?.slot === nextSlot && entry?.status === DATA_LIFECYCLE_STATUS.CURRENT) {
      return Object.freeze({
        ...entry,
        status: DATA_LIFECYCLE_STATUS.SUPERSEDED,
        supersededBy: nextId,
      });
    }
    return Object.freeze(entry);
  });
  const entry = Object.freeze({
    dataId: nextId,
    workId: text(workId),
    checkpointId: text(checkpointId),
    producer: text(producer).toUpperCase() || 'UNKNOWN',
    kind: text(kind).toUpperCase() || 'DATA',
    slot: nextSlot,
    payloadRef: payloadRef == null ? null : text(payloadRef),
    evidenceRefs: Object.freeze(unique(evidenceRefs)),
    ownerSystem: ownerSystem == null ? null : text(ownerSystem),
    truthOwner: truthOwner == null ? null : text(truthOwner),
    status: DATA_LIFECYCLE_STATUS.CURRENT,
    supersededBy: null,
    createdAt,
    managedBy: 'SECRETARY',
    aka: 'PRODUCT_LIFE_CYCLE',
  });
  return Object.freeze([...rotated, entry]);
}

export function archiveHallData(entries = [], dataId) {
  const id = text(dataId);
  return Object.freeze((Array.isArray(entries) ? entries : []).map(entry => (
    entry?.dataId === id
      ? Object.freeze({ ...clone(entry), status: DATA_LIFECYCLE_STATUS.ARCHIVED })
      : Object.freeze(clone(entry))
  )));
}

export function currentHallData(entries = []) {
  return Object.freeze((Array.isArray(entries) ? entries : [])
    .filter(entry => entry?.status === DATA_LIFECYCLE_STATUS.CURRENT)
    .map(clone));
}
