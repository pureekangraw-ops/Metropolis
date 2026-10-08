export const WORK_PASS_VERSION = 'WORK_PASS_V1';
export const WORK_PASS_STATUS = Object.freeze({
  ACTIVE:'ACTIVE', CANCELLED:'CANCELLED', COMPLETED:'COMPLETED',
});

const text = (value) => String(value ?? '').trim();
const unique = (values = []) => [...new Set(values.map(text).filter(Boolean))];
const clone = (value) => value == null ? value : structuredClone(value);

function required(value, label) {
  const normalized = text(value);
  if (!normalized) throw new Error(`${label}_REQUIRED`);
  return normalized;
}

export function createWorkPass({
  workId,
  checkpointId,
  actor,
  issuedAt = new Date().toISOString(),
  handoffStations = ['FACTORY_STATION'],
} = {}) {
  const id = required(workId, 'WORK_ID');
  const checkpoint = required(checkpointId, 'CHECKPOINT_ID');
  const holder = required(actor, 'ACTOR');
  if (!['GO', 'LIGHT'].includes(holder)) throw new Error('WORK_PASS_ACTOR_NOT_ALLOWED');

  return Object.freeze({
    kind: 'WORK_PASS',
    version: WORK_PASS_VERSION,
    passId: `WORK-PASS:${id}:${holder}`,
    workId: id,
    checkpointId: checkpoint,
    actor: holder,
    status: WORK_PASS_STATUS.ACTIVE,
    permissions: Object.freeze({
      actions: Object.freeze(['read', 'handoff', 'return', 'cancel', 'complete']),
      handoff: Object.freeze(unique(handoffStations).map(stationId => Object.freeze({ stationId }))),
    }),
    issuedBy: 'CITY_HALL',
    issuedAt: required(issuedAt, 'ISSUED_AT'),
    authorityTransferred: false,
  });
}

export function inspectWorkPass(pass, { workId, checkpointId, actor, workState = null } = {}) {
  if (!pass || pass.kind !== 'WORK_PASS' || pass.version !== WORK_PASS_VERSION) {
    return Object.freeze({ valid: false, reason: 'WORK_PASS_MISSING', actions: Object.freeze([]) });
  }
  if (
    pass.workId !== text(workId)
    || pass.checkpointId !== text(checkpointId)
    || pass.actor !== text(actor)
  ) {
    return Object.freeze({ valid: false, reason: 'WORK_PASS_SCOPE_MISMATCH', actions: Object.freeze([]) });
  }

  if ([WORK_PASS_STATUS.CANCELLED, WORK_PASS_STATUS.COMPLETED].includes(pass.status)
    || ['CANCELLED','COMPLETED'].includes(text(workState).toUpperCase())) {
    return Object.freeze({ valid:true, reason:'WORK_PASS_CLOSED_READ_ONLY', actions:Object.freeze(['read']) });
  }
  if (pass.status !== WORK_PASS_STATUS.ACTIVE) {
    return Object.freeze({ valid: false, reason: 'WORK_PASS_INACTIVE', actions: Object.freeze([]) });
  }

  const actions = unique(Array.isArray(pass.permissions?.actions) ? pass.permissions.actions : []);
  return Object.freeze({ valid: true, reason: 'WORK_PASS_ACTIVE', actions: Object.freeze(actions) });
}

export function workPassAllowsHandoff(pass, { workId, checkpointId, actor, workState = null, stationId } = {}) {
  const inspection = inspectWorkPass(pass, { workId, checkpointId, actor, workState });
  if (!inspection.valid || !inspection.actions.includes('handoff')) return false;
  const destination = text(stationId);
  return (Array.isArray(pass.permissions?.handoff) ? pass.permissions.handoff : [])
    .some(rule => text(rule?.stationId) === destination);
}

export function closeWorkPass(pass,{status=WORK_PASS_STATUS.CANCELLED,closedAt=new Date().toISOString(),closedBy='MIMIR'}={}) {
  if (!pass) return null;
  const nextStatus=text(status).toUpperCase();
  if (![WORK_PASS_STATUS.CANCELLED,WORK_PASS_STATUS.COMPLETED].includes(nextStatus)) throw new Error('WORK_PASS_CLOSE_STATUS_INVALID');
  const at=required(closedAt,'CLOSED_AT'); const by=required(closedBy,'CLOSED_BY');
  return Object.freeze({...clone(pass),status:nextStatus,closedAt:at,closedBy:by,
    ...(nextStatus===WORK_PASS_STATUS.CANCELLED?{cancelledAt:at,cancelledBy:by}:{completedAt:at,completedBy:by})});
}
export function cancelWorkPass(pass,{cancelledAt=new Date().toISOString(),cancelledBy='MIMIR'}={}) {
  return closeWorkPass(pass,{status:WORK_PASS_STATUS.CANCELLED,closedAt:cancelledAt,closedBy:cancelledBy});
}
export function completeWorkPass(pass,{completedAt=new Date().toISOString(),completedBy='MIMIR'}={}) {
  return closeWorkPass(pass,{status:WORK_PASS_STATUS.COMPLETED,closedAt:completedAt,closedBy:completedBy});
}

export function workPassRef(pass) {
  return pass?.passId ? `work-pass://${pass.passId}` : null;
}
