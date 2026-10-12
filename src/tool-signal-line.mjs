// Tool-to-tool real-time signaling. This is a transport/presence line, NOT Work lifecycle truth.
// The authenticated station identity must be supplied by the server, never trusted from the payload.
const PREFIX = 'hall:tool-signal:';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const copy = value => value == null ? value : structuredClone(value);
export const TOOL_EVENT_TYPES = Object.freeze(['TOOL_DONE', 'ERROR', 'APPROVAL_REQUIRED']);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

function validateEvent({ body, workId, checkpointId }) {
  if (body.schema !== 'TOOL_EVENT_V1') throw new Error('TOOL_EVENT_SCHEMA_INVALID');
  if (!TOOL_EVENT_TYPES.includes(body.eventType)) throw new Error('TOOL_EVENT_TYPE_INVALID');
  if (!workId || !checkpointId) throw new Error('TOOL_EVENT_WORK_CONTEXT_REQUIRED');
  if (body.eventType === 'TOOL_DONE') {
    if (!Array.isArray(body.evidenceRefs) || body.evidenceRefs.length === 0
      || body.evidenceRefs.some(ref => !nonEmptyString(ref))) {
      throw new Error('TOOL_DONE_EVIDENCE_REQUIRED');
    }
  }
  if (['ERROR', 'APPROVAL_REQUIRED'].includes(body.eventType) && !nonEmptyString(body.reason)) {
    throw new Error('TOOL_EVENT_REASON_REQUIRED');
  }
  if (body.checkpointRefs != null) {
    const refs = body.checkpointRefs;
    if (!refs || typeof refs !== 'object' || Array.isArray(refs)) {
      throw new Error('TOOL_EVENT_CHECKPOINT_REFS_INVALID');
    }
    if (Object.keys(refs).some(key => !['safeCandidateRef', 'errorCaptureRef'].includes(key))) {
      throw new Error('TOOL_EVENT_CHECKPOINT_REFS_INVALID');
    }
    if (Object.values(refs).some(ref => ref != null && !nonEmptyString(ref))) {
      throw new Error('TOOL_EVENT_CHECKPOINT_REFS_INVALID');
    }
    if (refs.safeCandidateRef && body.eventType !== 'TOOL_DONE') {
      throw new Error('SAFE_CANDIDATE_REF_EVENT_INVALID');
    }
    if (refs.errorCaptureRef && body.eventType !== 'ERROR') {
      throw new Error('ERROR_CAPTURE_REF_EVENT_INVALID');
    }
  }
}

export function createToolSignalLine({store, clock=()=>new Date().toISOString(), maxAgeMs=60000}={}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new Error('TOOL_SIGNAL_STORE_REQUIRED');
  async function presence(toolId, now=Date.now()) {
    if (!validId(toolId)) throw new Error('TOOL_ID_INVALID');
    const entry=await store.get(PREFIX+'presence:'+toolId);
    if (!entry) return {toolId,status:'UNKNOWN'};
    const age=now-Date.parse(entry.observedAt);
    return {...copy(entry),status:!Number.isFinite(age)||age>maxAgeMs?'STALE':entry.status};
  }
  async function heartbeat({actor,toolId,status='ONLINE'}={}) {
    if (!validId(actor)||actor!==toolId) throw new Error('TOOL_SIGNAL_ACTOR_MISMATCH');
    if (!['ONLINE','BUSY','OFFLINE','ERROR'].includes(status)) throw new Error('TOOL_STATUS_INVALID');
    const previous=await store.get(PREFIX+'presence:'+toolId);
    const record={kind:'TOOL_PRESENCE',toolId,status,sequence:(previous?.sequence||0)+1,observedAt:clock()};
    await store.put(PREFIX+'presence:'+toolId,record);
    return copy(record);
  }
  async function send({actor,from,to,workId=null,checkpointId=null,kind='MESSAGE',body={},messageId}={}) {
    if (!validId(actor)||actor!==from) throw new Error('TOOL_SIGNAL_ACTOR_MISMATCH');
    if (![from,to,messageId].every(validId)) throw new Error('TOOL_SIGNAL_ADDRESS_INVALID');
    if (!['MESSAGE','EVENT','ACK'].includes(kind)) throw new Error('TOOL_SIGNAL_KIND_INVALID');
    if (workId!==null&&!validId(workId)) throw new Error('WORK_ID_INVALID');
    if (checkpointId!==null&&!validId(checkpointId)) throw new Error('CHECKPOINT_ID_INVALID');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('TOOL_SIGNAL_BODY_INVALID');
    if (kind === 'EVENT') validateEvent({ body, workId, checkpointId });
    const encoded=JSON.stringify(body);
    if (!encoded||encoded.length>4096) throw new Error('TOOL_SIGNAL_BODY_TOO_LARGE');
    const key=PREFIX+'message:'+from+':'+messageId;
    const prior=await store.get(key);
    if (prior) {
      if (prior.to!==to||prior.signalKind!==kind||prior.workId!==workId||prior.checkpointId!==checkpointId||JSON.stringify(prior.body)!==encoded) throw new Error('TOOL_SIGNAL_IDEMPOTENCY_CONFLICT');
      return copy(prior);
    }
    const record={kind:'TOOL_SIGNAL',messageId,from,to,signalKind:kind,workId,checkpointId,body:copy(body),observedAt:clock()};
    await store.put(key,record);
    await store.put(PREFIX+'inbox:'+to+':'+from+':'+messageId,record);
    return copy(record);
  }
  async function inbox({actor,toolId}={}) {
    if (!validId(actor)||actor!==toolId) throw new Error('TOOL_SIGNAL_ACTOR_MISMATCH');
    if (typeof store.list!=='function') throw new Error('TOOL_SIGNAL_LIST_NOT_SUPPORTED');
    const rows=await store.list(PREFIX+'inbox:'+toolId+':');
    return rows.map(x=>copy(x.value)).filter(Boolean);
  }
  return Object.freeze({heartbeat,presence,send,inbox});
}
