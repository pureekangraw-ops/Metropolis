export const PIXIE_REPORT_ROLE = Object.freeze({
  id: 'PIXIE',
  role: 'TOOL_RESULT_REPORT_ROUTER',
  destination: 'SECRETARY',
  nextRecipient: 'OWNER',
  ownsWorkTruth: false,
  mayApprove: false,
  mayRewriteToolEvidence: false,
});

const text = value => String(value ?? '').trim();
const clone = value => value == null ? value : structuredClone(value);
const unique = values => [...new Set((Array.isArray(values) ? values : []).map(text).filter(Boolean))];

export function createPixieReport({
  reportId,
  workId,
  checkpointId,
  ownerSystem,
  sourceTool,
  status = 'UNKNOWN',
  result = null,
  artifactRefs = [],
  evidenceRefs = [],
  receiptRefs = [],
  unknowns = [],
  observedAt = new Date().toISOString(),
} = {}) {
  const id = text(reportId);
  if (!id) throw new Error('REPORT_ID_REQUIRED');
  return Object.freeze({
    schema: 'PIXIE_TOOL_REPORT_V1',
    reportId: id,
    workId: text(workId),
    checkpointId: text(checkpointId),
    ownerSystem: text(ownerSystem) || null,
    sourceTool: text(sourceTool) || 'UNKNOWN_TOOL',
    status: text(status).toUpperCase() || 'UNKNOWN',
    result: clone(result),
    artifactRefs: Object.freeze(unique(artifactRefs)),
    evidenceRefs: Object.freeze(unique(evidenceRefs)),
    receiptRefs: Object.freeze(unique(receiptRefs)),
    unknowns: Object.freeze(unique(unknowns)),
    route: Object.freeze({
      from: 'PIXIE',
      to: 'SECRETARY',
      then: 'OWNER',
      final: 'WORKER',
    }),
    observedAt,
    authorityTransferred: false,
  });
}


export function createPixieStationDiagnostic({
  diagnosticId, workId, checkpointId, journeyId, stationId,
  before = {}, after = {}, unreadableRefs = [], observedAt = new Date().toISOString(),
} = {}) {
  const id = text(diagnosticId);
  if (!id) throw new Error('DIAGNOSTIC_ID_REQUIRED');
  const keys = ['payloadRefs', 'artifactRefs', 'evidenceRefs', 'receiptRefs'];
  const normalize = value => Object.fromEntries(keys.map(key => [key, unique(value?.[key] || [])]));
  const rawAfter = Object.fromEntries(keys.map(key => [key, Array.isArray(after?.[key]) ? after[key].map(text).filter(Boolean) : []]));
  const a = normalize(after);
  const b = normalize(before);
  const added = Object.fromEntries(keys.map(key => [key, a[key].filter(ref => !b[key].includes(ref))]));
  const duplicates = Object.fromEntries(keys.map(key => [key, rawAfter[key].filter((ref,index,all)=>all.indexOf(ref)!==index)]));
  const counts = Object.fromEntries(keys.map(key => [key, a[key].length]));
  const unknowns = unique(unreadableRefs);
  return Object.freeze({
    schema:'PIXIE_STATION_DIAGNOSTIC_V1', diagnosticId:id,
    workId:text(workId)||null, checkpointId:text(checkpointId)||null, journeyId:text(journeyId)||null, stationId:text(stationId)||null,
    status:unknowns.length?'CHECKED_WITH_UNKNOWNS':'CHECKED',
    counts:Object.freeze(counts),
    added:Object.freeze(Object.fromEntries(keys.map(key=>[key,Object.freeze(added[key])]))),
    duplicates:Object.freeze(Object.fromEntries(keys.map(key=>[key,Object.freeze(unique(duplicates[key]))]))),
    unreadableRefs:Object.freeze(unknowns), mayApprove:false, mayRewriteSourceTruth:false, observedAt,
  });
}
