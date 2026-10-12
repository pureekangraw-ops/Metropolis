// Read-only projection for HERMES. Transport acceptance is not worker execution.
const text = value => String(value ?? '').trim();
const TERMINAL = new Set(['COMPLETED', 'CANCELLED', 'CANCELED']);
export function projectWorkTracking(record, { observedAt = new Date().toISOString() } = {}) {
  if (!record?.workId || !record?.checkpointId) throw new Error('WORK_TRACKING_IDENTITY_REQUIRED');
  const journey = Array.isArray(record.journeys) ? record.journeys.at(-1) : null;
  const handoff = record.handoff ?? null;
  const external = handoff?.external ?? null;
  const report = Array.isArray(record.reports) ? record.reports.at(-1) : null;
  const returned = Boolean(record.return || journey?.status === 'RETURNED');
  const terminal = TERMINAL.has(text(record.state).toUpperCase());
  const workerEvidence = external?.domainVerified === true || report?.result?.domainVerified === true;
  const transportVerified = external?.boundaryVerified === true && external?.verified === true;
  const execution = terminal ? 'CLOSED' : returned ? 'RETURNED' : workerEvidence ? 'VERIFIED' : handoff ? 'UNKNOWN' : 'NOT_DISPATCHED';
  return Object.freeze({
    schema: 'HERMES_WORK_TRACKING_V1',
    workId: record.workId,
    checkpointId: record.checkpointId,
    workState: text(record.state) || 'UNKNOWN',
    signal: record.online?.status === 'ONLINE' ? 'ONLINE' : record.online?.status === 'OFFLINE' ? 'OFFLINE' : 'UNKNOWN',
    stationId: journey?.stationId ?? handoff?.stationId ?? null,
    journeyId: journey?.journeyId ?? null,
    journeyStatus: journey?.status ?? null,
    jobId: external?.jobId ?? report?.result?.jobId ?? null,
    transport: transportVerified ? 'VERIFIED' : handoff ? 'UNVERIFIED' : 'NOT_SENT',
    execution,
    evidenceRef: workerEvidence ? external?.evidenceRef ?? null : null,
    observedAt,
    // A live stream must source updates from the owner; this projection does not poll.
    freshness: 'SNAPSHOT',
  });
}
