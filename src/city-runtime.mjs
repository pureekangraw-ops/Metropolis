import { createCargoEnvelope, deliverCargo, createMailbox, MAILBOX_STATUS } from './post-office.mjs';
import { prepareMimirReturn } from './agents/mimir/return-desk.mjs';
import { rotateHallData } from './secretary/product-life-cycle.mjs';
import { createPixieReport } from './pixie/report-router.mjs';

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
    stations: Object.freeze(['METROPOLIS_STATION', 'FACTORY_STATION', 'PRISM_STATION', 'DRIVE_STATION', 'NOTION_STATION', 'OBSERVATORY_STATION']),
    paths: Object.freeze(['SHOP_TO_HALL', 'TAILOR_TO_HALL', 'HALL_TO_PIXIE_SERVICE', 'HALL_TO_STATION', 'POST_OFFICE_TO_MAILBOX']),
    rails: Object.freeze([]),
  });
}

export function createCityRuntime({ store = createMemoryStore(), clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), sourceSha = 'UNKNOWN', stationRuntimes = {} } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('store_REQUIRED');
  const mailboxes = new Map();
  const stations = Object.freeze({ ...stationRuntimes });

  async function intake({ workId = idFactory(), checkpointId, ownerSystem, requestedBy = 'UNKNOWN', inputRefs = [] } = {}) {
    const id = text(workId, 'workId');
    const owner = text(ownerSystem, 'ownerSystem');
    const existing = await store.get(`work:${id}`);
    if (existing) throw new Error('WORK_ALREADY_EXISTS');
    const now = clock();
    const cp = checkpointId == null ? `${id}:CP-01` : text(checkpointId, 'checkpointId');
    const dataLifecycle = rotateHallData([], {
      dataId: `${id}:DATA:COUNTER:1`,
      workId: id,
      checkpointId: cp,
      producer: 'COUNTER',
      kind: 'INTAKE',
      payloadRef: inputRefs[0] || null,
      ownerSystem: owner,
      truthOwner: owner,
      createdAt: now,
    });
    const record = {
      kind: 'WORK_RECORD',
      workId: id,
      ownerSystem: owner,
      requestedBy: text(requestedBy, 'requestedBy'),
      state: WORK_STATE.RECEIVED,
      checkpointId: cp,
      inputRefs: [...inputRefs],
      handoff: null,
      returnReview: null,
      return: null,
      reports: [],
      dataLifecycle,
      history: [{ state: WORK_STATE.RECEIVED, at: now }],
      sourceSha,
      updatedAt: now,
    };
    await store.put(`work:${id}`, record);
    return clone(record);
  }

  async function handoff({ workId, checkpointId, stationId, operation, actor = 'HERMES', payload = {} } = {}) {
    const id = text(workId, 'workId');
    const record = await store.get(`work:${id}`);
    if (!record) throw new Error('WORK_NOT_FOUND');
    if (record.checkpointId !== text(checkpointId, 'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');
    const station = text(stationId, 'stationId');
    const op = text(operation, 'operation');
    const stationRuntime = stations[station];
    const external = stationRuntime?.handoff
      ? await stationRuntime.handoff({ workId: id, checkpointId: record.checkpointId, stationId: station, operation: op, actor, payload: clone(payload) })
      : null;
    const now = clock();
    const handoff = { handoffId: idFactory(), actor: text(actor, 'actor'), stationId: station, operation: op, payload: clone(payload), external: clone(external), createdAt: now };
    let reports = [...(record.reports || [])];
    let dataLifecycle = [...(record.dataLifecycle || [])];
    if (external) {
      const reportId = `${id}:PIXIE:HANDOFF:${reports.length + 1}`;
      const report = createPixieReport({
        reportId,
        workId: id,
        checkpointId: record.checkpointId,
        ownerSystem: record.ownerSystem,
        sourceTool: station,
        status: external.verified === true ? 'VERIFIED' : 'UNKNOWN',
        result: external,
        evidenceRefs: external.evidenceRef ? [external.evidenceRef] : [],
        receiptRefs: external.receiptId ? [external.receiptId] : [],
        observedAt: now,
      });
      reports = [...reports, report];
      dataLifecycle = rotateHallData(dataLifecycle, {
        dataId: `${id}:DATA:PIXIE:${reports.length}`,
        workId: id,
        checkpointId: record.checkpointId,
        producer: 'PIXIE',
        kind: 'TOOL_REPORT',
        payloadRef: `pixie-report://${reportId}`,
        evidenceRefs: report.evidenceRefs,
        ownerSystem: record.ownerSystem,
        truthOwner: record.ownerSystem,
        createdAt: now,
      });
    }
    const next = {
      ...record,
      state: WORK_STATE.HANDED_OFF,
      handoff,
      reports,
      dataLifecycle,
      history: [...record.history, { state: WORK_STATE.HANDED_OFF, at: now }].slice(station === 'OBSERVATORY_STATION' ? -100 : 0),
      updatedAt: now,
    };
    await store.put(`work:${id}`, next);
    return clone(next);
  }

  async function returnWork({
    workId,
    checkpointId,
    readback,
    evidenceRefs = [],
    updates = [],
    confirmation = null,
    verified = false,
    actor = 'MIMIR',
  } = {}) {
    const id = text(workId, 'workId');
    const record = await store.get(`work:${id}`);
    if (!record) throw new Error('WORK_NOT_FOUND');
    if (record.checkpointId !== text(checkpointId, 'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');

    const review = prepareMimirReturn({
      workId: id,
      checkpointId: record.checkpointId,
      readback,
      evidenceRefs,
      updates,
      confirmation,
      observedAt: clock(),
    });

    if (review.status !== 'CONFIRMED') {
      const now = clock();
      const pending = {
        ...record,
        returnReview: clone(review),
        updatedAt: now,
      };
      await store.put(`work:${id}`, pending);
      return clone(pending);
    }

    const stationRuntime = stations[record.handoff?.stationId];
    let trustedReadback = null;
    let trustedVerified = verified === true;
    const trustedEvidence = [...evidenceRefs];
    if (stationRuntime?.readback && record.handoff?.external) {
      trustedReadback = await stationRuntime.readback({ workId: id, checkpointId: record.checkpointId, handoff: clone(record.handoff) });
      trustedVerified = trustedReadback?.verified === true && trustedReadback?.domainVerified === true;
      if (trustedReadback?.evidenceRef && !trustedEvidence.includes(trustedReadback.evidenceRef)) trustedEvidence.push(trustedReadback.evidenceRef);
    }

    const now = clock();
    const organized = prepareMimirReturn({
      workId: id,
      checkpointId: record.checkpointId,
      readback: trustedReadback || readback,
      evidenceRefs: trustedEvidence,
      updates,
      confirmation,
      observedAt: now,
    });

    const reports = [...(record.reports || [])];
    const reportId = `${id}:PIXIE:RETURN:${reports.length + 1}`;
    const report = createPixieReport({
      reportId,
      workId: id,
      checkpointId: record.checkpointId,
      ownerSystem: record.ownerSystem,
      sourceTool: record.handoff?.stationId || 'RETURN_DESK',
      status: trustedVerified ? 'VERIFIED' : 'UNKNOWN',
      result: trustedReadback || readback,
      artifactRefs: Array.isArray(trustedReadback?.result?.artifactRefs) ? trustedReadback.result.artifactRefs : [],
      evidenceRefs: trustedEvidence,
      receiptRefs: record.handoff?.external?.receiptId ? [record.handoff.external.receiptId] : [],
      unknowns: trustedVerified ? [] : ['OWNER_EXECUTION_NOT_VERIFIED'],
      observedAt: now,
    });
    const nextReports = [...reports, report];

    let dataLifecycle = rotateHallData(record.dataLifecycle || [], {
      dataId: `${id}:DATA:PIXIE:${nextReports.length}`,
      workId: id,
      checkpointId: record.checkpointId,
      producer: 'PIXIE',
      kind: 'TOOL_REPORT',
      payloadRef: `pixie-report://${reportId}`,
      evidenceRefs: report.evidenceRefs,
      ownerSystem: record.ownerSystem,
      truthOwner: record.ownerSystem,
      createdAt: now,
    });
    dataLifecycle = rotateHallData(dataLifecycle, {
      dataId: `${id}:DATA:MIMIR:${nextReports.length}`,
      workId: id,
      checkpointId: record.checkpointId,
      producer: 'MIMIR',
      kind: 'RETURN_PACKET',
      payloadRef: `mimir-return://${id}/${record.checkpointId}`,
      evidenceRefs: trustedEvidence,
      ownerSystem: record.ownerSystem,
      truthOwner: record.ownerSystem,
      createdAt: now,
    });

    const state = trustedVerified ? WORK_STATE.RETURNED : WORK_STATE.UNKNOWN;
    const next = {
      ...record,
      state,
      returnReview: clone(organized),
      reports: nextReports,
      dataLifecycle,
      return: {
        actor: text(actor, 'actor'),
        readback: clone(trustedReadback || readback),
        evidenceRefs: trustedEvidence,
        organized: clone(organized.organized),
        verified: trustedVerified,
        returnedAt: now,
      },
      history: [...record.history, { state, at: now }],
      updatedAt: now,
    };
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
