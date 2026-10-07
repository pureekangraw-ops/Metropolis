import { HERMES_INTAKE_FLOW } from './intake-desk.mjs';
export const HERMES_STATION_ROLE = Object.freeze({
  id: 'HERMES',
  role: 'STATION_RECEPTION_AND_CONTINUITY',
  station: 'AGENT_ARRIVAL_STATION',
  duties: Object.freeze(['WELCOME', 'TABLET_HANDOFF', 'TABLET_RECEIVE', 'LOST_AND_FOUND']),
  ownsWorkTruth: false,
  mayCreateWork: false,
  mayCreateAuthority: false,
});

const text = value => String(value ?? '').trim();
const clone = value => value == null ? value : structuredClone(value);

function tabletPointer(work = {}) {
  return Object.freeze({
    workId: text(work.workId),
    present: work.present === true,
    state: text(work.state) || 'UNKNOWN',
    checkpointId: work.checkpointId == null ? null : text(work.checkpointId),
    ownerSystem: work.ownerSystem == null ? null : text(work.ownerSystem),
    updatedAt: work.updatedAt || null,
    tablet: work.tablet ? Object.freeze({
      tabletId: work.tablet?.tablet?.tabletId || null,
      version: work.tablet?.tablet?.version || null,
      status: work.tablet?.status || 'UNKNOWN',
      verified: work.tablet?.verified === true,
      storageRef: work.tablet?.storageRef || null,
      checksum: work.tablet?.checksum || null,
    }) : null,
  });
}

export function createHermesReception({ actor, works = [], observedAt = new Date().toISOString() } = {}) {
  const visible = (Array.isArray(works) ? works : [])
    .filter(work => text(work?.workId))
    .map(tabletPointer);
  const lostAndFound = visible
    .filter(work => work.present && work.checkpointId)
    .map(work => Object.freeze({
      workId: work.workId,
      checkpointId: work.checkpointId,
      state: work.state,
      ownerSystem: work.ownerSystem,
      updatedAt: work.updatedAt,
    }));

  return Object.freeze({
    staff: HERMES_STATION_ROLE,
    actor: text(actor) || 'UNKNOWN',
    welcome: 'READY',
    intakeDesk: Object.freeze({
      available: true,
      flow: HERMES_INTAKE_FLOW,
      anchor: 'WORK_FLOW',
      securityVisibleAsNavigation: false,
    }),
    tabletDesk: Object.freeze({
      available: visible.length > 0,
      pointers: Object.freeze(visible),
    }),
    lostAndFound: Object.freeze({
      available: lostAndFound.length > 0,
      candidates: Object.freeze(lostAndFound),
      rule: 'RETURN_EXISTING_WORK_POINTER_ONLY',
      createsWork: false,
    }),
    observedAt,
  });
}

export function findHermesLostWork(reception, workId) {
  const id = text(workId);
  if (!id) return null;
  const match = reception?.lostAndFound?.candidates?.find(item => item.workId === id);
  return match ? clone(match) : null;
}
