import { createCargoEnvelope, deliverCargo, createMailbox, MAILBOX_STATUS } from './post-office.mjs';

export const CITY_COMPONENTS = Object.freeze(['METROPOLIS', 'CITY_HALL', 'WORK_SYSTEM', 'POST_OFFICE', 'PIXIE_SERVICE', 'SHOP', 'SPECTRUMSALE', 'THE_TAILOR']);
export const WORK_STATE = Object.freeze({ RECEIVED: 'RECEIVED', HANDED_OFF: 'HANDED_OFF', RETURNED: 'RETURNED', UNKNOWN: 'UNKNOWN' });

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`);
  return value.trim();
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function createMemoryStore() {
  const records = new Map();
  return Object.freeze({
    async get(key) { return clone(records.get(text(key, 'key'))); },
    async put(key, value) { records.set(text(key, 'key'), clone(value)); return clone(value); },
    async list(prefix = '') { return [...records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) })); },
  });
}

export function createRailLink({ railId, endpoints, trustBoundary } = {}) {
  const id = text(railId, 'railId');
  if (!Array.isArray(endpoints) || endpoints.length !== 2) throw new TypeError('rail_endpoints_MUST_HAVE_EXACTLY_TWO');
  const normalized = endpoints.map((endpoint) => Object.freeze({ stationId: text(endpoint.stationId, 'endpoint.stationId'), systemId: text(endpoint.systemId, 'endpoint.systemId') }));
  if (normalized[0].stationId === normalized[1].stationId) throw new Error('rail_endpoints_MUST_BE_DISTINCT');
  return Object.freeze({ kind: 'RAIL_LINK', railId: id, endpoints: Object.freeze(normalized), trustBoundary: text(trustBoundary, 'trustBoundary') });
}

export function createCityMap() {
  return Object.freeze({
    city: 'METROPOLIS',
    components: CITY_COMPONENTS,
    stations: Object.freeze(['METROPOLIS_STATION', 'FACTORY_STATION', 'PRISM_STATION', 'DRIVE_STATION', 'NOTION_STATION']),
    paths: Object.freeze(['SHOP_TO_HALL', 'TAILOR_TO_HALL', 'HALL_TO_PIXIE_SERVICE', 'HALL_TO_STATION', 'POST_OFFICE_TO_MAILBOX']),
    rails: Object.freeze([]),
  });
}

export function createCityRuntime({ store = createMemoryStore(), clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), sourceSha = 'UNKNOWN' } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('store_REQUIRED');
  const mailboxes = new Map();

  async function intake({ workId = idFactory(), ownerSystem, requestedBy = 'UNKNOWN', inputRefs = [] } = {}) {
    const id = text(workId, 'workId');
    const owner = text(ownerSystem, 'ownerSystem');
    const existing = await store.get(`work:${id}`);
    if (existing) throw new Error('WORK_ALREADY_EXISTS');
    const now = clock();
    const record = { kind: 'WORK_RECORD', workId: id, ownerSystem: owner, requestedBy: text(requestedBy, 'requestedBy'), state: WORK_STATE.RECEIVED, checkpointId: `${id}:CP-01`, inputRefs: [...inputRefs], handoff: null, return: null, history: [{ state: WORK_STATE.RECEIVED, at: now }], sourceSha, updatedAt: now };
    await store.put(`work:${id}`, record);
    return clone(record);
  }

  async function handoff({ workId, checkpointId, stationId, railId, operation, actor = 'HERMES', payload = {} } = {}) {
    const id = text(workId, 'workId');
    const record = await store.get(`work:${id}`);
    if (!record) throw new Error('WORK_NOT_FOUND');
    if (record.checkpointId !== text(checkpointId, 'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');
    const now = clock();
    const handoff = { handoffId: idFactory(), actor: text(actor, 'actor'), stationId: text(stationId, 'stationId'), railId: text(railId, 'railId'), operation: text(operation, 'operation'), payload: clone(payload), createdAt: now };
    const next = { ...record, state: WORK_STATE.HANDED_OFF, handoff, history: [...record.history, { state: WORK_STATE.HANDED_OFF, at: now }], updatedAt: now };
    await store.put(`work:${id}`, next);
    return clone(next);
  }

  async function returnWork({ workId, checkpointId, readback, evidenceRefs = [], verified = false, actor = 'MIMIR' } = {}) {
    const id = text(workId, 'workId');
    const record = await store.get(`work:${id}`);
    if (!record) throw new Error('WORK_NOT_FOUND');
    if (record.checkpointId !== text(checkpointId, 'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');
    const now = clock();
    const state = verified === true ? WORK_STATE.RETURNED : WORK_STATE.UNKNOWN;
    const next = { ...record, state, return: { actor: text(actor, 'actor'), readback: clone(readback), evidenceRefs: [...evidenceRefs], verified: verified === true, returnedAt: now }, history: [...record.history, { state, at: now }], updatedAt: now };
    await store.put(`work:${id}`, next);
    return clone(next);
  }

  function registerMailbox(input) {
    const mailbox = createMailbox(input);
    mailboxes.set(mailbox.mailboxId, mailbox);
    return clone(mailbox);
  }

  async function sendCargo(input) {
    const envelope = createCargoEnvelope(input);
    const mailbox = mailboxes.get(envelope.mailbox);
    return clone(deliverCargo(envelope, { mailbox, receiptId: idFactory(), observedAt: clock() }));
  }

  async function getWork(workId) { return store.get(`work:${text(workId, 'workId')}`); }
  async function health() { return { service: 'metropolis', status: 'READY', sourceSha, components: Object.fromEntries(CITY_COMPONENTS.map((component) => [component, { status: 'READY' }])), mailboxCount: [...mailboxes.values()].filter((mailbox) => mailbox.status === MAILBOX_STATUS.OPEN).length, observedAt: clock() }; }

  return Object.freeze({ intake, handoff, returnWork, registerMailbox, sendCargo, getWork, health, map: createCityMap() });
}
