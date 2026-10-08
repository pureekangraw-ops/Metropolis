export const WORK_SIGNAL_STATUS = Object.freeze({ ONLINE:'ONLINE', OFFLINE:'OFFLINE' });
export const WORK_SIGNAL_PUBLISHERS = Object.freeze(['HERMES', 'MIMIR']);

const CURRENT_PREFIX = 'hall:work-state:current:';
const EVENT_PREFIX = 'hall:work-state:event:';

const clone = value => value == null ? value : structuredClone(value);
const text = value => String(value ?? '').trim();

function required(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label}_REQUIRED`);
  return normalized;
}

function validatePublisherStatus(publisher, status) {
  if (!WORK_SIGNAL_PUBLISHERS.includes(publisher)) throw new Error('WORK_SIGNAL_PUBLISHER_NOT_ALLOWED');
  if (publisher === 'HERMES' && status !== WORK_SIGNAL_STATUS.ONLINE) throw new Error('HERMES_SIGNAL_MUST_BE_ONLINE');
  if (publisher === 'MIMIR' && status !== WORK_SIGNAL_STATUS.OFFLINE) throw new Error('MIMIR_SIGNAL_MUST_BE_OFFLINE');
}

export function createWorkStateSignalLine({ store, clock = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new Error('WORK_SIGNAL_STORE_REQUIRED');

  async function getCurrent(workId) {
    return clone(await store.get(`${CURRENT_PREFIX}${required(workId, 'WORK_ID')}`));
  }

  async function publish({
    workId,
    checkpointId,
    status,
    publisher,
    workState = 'UNKNOWN',
    reason = null,
  } = {}) {
    const id = required(workId, 'WORK_ID');
    const checkpoint = required(checkpointId, 'CHECKPOINT_ID');
    const nextStatus = required(status, 'WORK_SIGNAL_STATUS').toUpperCase();
    const source = required(publisher, 'WORK_SIGNAL_PUBLISHER').toUpperCase();
    if (!Object.values(WORK_SIGNAL_STATUS).includes(nextStatus)) throw new Error('WORK_SIGNAL_STATUS_INVALID');
    validatePublisherStatus(source, nextStatus);

    const previous = await getCurrent(id);
    const sequence = Number.isInteger(previous?.sequence) ? previous.sequence + 1 : 1;
    const observedAt = clock();
    const signal = Object.freeze({
      kind: 'WORK_STATE_SIGNAL',
      version: '1.0.0',
      line: 'CITY_HALL_WORK_STATE',
      workId: id,
      checkpointId: checkpoint,
      status: nextStatus,
      workState: text(workState) || 'UNKNOWN',
      publisher: source,
      sequence,
      reason: text(reason) || null,
      observedAt,
    });

    await store.put(`${EVENT_PREFIX}${id}:${String(sequence).padStart(12, '0')}`, signal);
    await store.put(`${CURRENT_PREFIX}${id}`, signal);
    return clone(signal);
  }

  async function listCurrent() {
    if (typeof store.list !== 'function') throw new Error('WORK_SIGNAL_LIST_NOT_SUPPORTED');
    const rows = await store.list(CURRENT_PREFIX);
    return rows.map(row => clone(row?.value)).filter(Boolean);
  }

  async function listHistory(workId) {
    if (typeof store.list !== 'function') throw new Error('WORK_SIGNAL_LIST_NOT_SUPPORTED');
    const id = required(workId, 'WORK_ID');
    const rows = await store.list(`${EVENT_PREFIX}${id}:`);
    return rows.map(row => clone(row?.value)).filter(Boolean).sort((a, b) => a.sequence - b.sequence);
  }

  return Object.freeze({ publish, getCurrent, listCurrent, listHistory });
}
