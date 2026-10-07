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
