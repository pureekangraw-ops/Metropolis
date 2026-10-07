import {
  tabletObjectKey,
  tabletStorageRef,
  tabletDraftObjectKey,
  tabletDraftStorageRef,
} from './tablet-storage.mjs';

export const TABLET_STANDARD = Object.freeze({
  schema: 'WORK_TABLET_V1',
  version: '1.1.0',
  issuer: 'HERMES',
  station: 'AGENT_ARRIVAL_STATION',
  ownsWorkTruth: false,
  mayCreateAuthority: false,
});

export const TABLET_DRAFT_STANDARD = Object.freeze({
  schema: 'INTAKE_TABLET_DRAFT_V1',
  version: '1.0.0',
  issuer: 'HERMES',
  station: 'AGENT_ARRIVAL_STATION',
  ownsWorkTruth: false,
  createsWork: false,
});

const text = value => String(value ?? '').trim();
const clone = value => value == null ? value : structuredClone(value);

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function manifestFor(record = {}, {
  actor = 'HERMES',
  sourceSha = 'UNKNOWN',
  issuedAt = new Date().toISOString(),
} = {}) {
  const workId = text(record.workId);
  const checkpointId = text(record.checkpointId);
  if (!workId) throw new Error('WORK_ID_REQUIRED');
  if (!checkpointId) throw new Error('CHECKPOINT_ID_REQUIRED');
  return Object.freeze({
    schema: TABLET_STANDARD.schema,
    version: TABLET_STANDARD.version,
    tabletId: `TABLET:${workId}:${checkpointId}`,
    workId,
    checkpointId,
    originDraftId: text(record.intakeDraftId) || null,
    ownerSystem: text(record.ownerSystem) || null,
    state: text(record.state) || 'UNKNOWN',
    issuedBy: text(actor) || 'HERMES',
    station: TABLET_STANDARD.station,
    sourceSha: text(sourceSha) || 'UNKNOWN',
    refs: Object.freeze({
      input: Object.freeze([...(record.inputRefs || [])]),
      artifacts: Object.freeze([]),
      evidence: Object.freeze([]),
    }),
    lineage: Object.freeze({
      workId,
      checkpointId,
      previousTabletId: null,
    }),
    issuedAt,
    ownsWorkTruth: false,
    authorityCreated: false,
  });
}

function draftManifestFor(draft = {}, {
  actor = 'HERMES',
  sourceSha = 'UNKNOWN',
  savedAt = new Date().toISOString(),
} = {}) {
  const draftId = text(draft.draftId);
  if (!draftId) throw new Error('DRAFT_ID_REQUIRED');
  return Object.freeze({
    schema: TABLET_DRAFT_STANDARD.schema,
    version: TABLET_DRAFT_STANDARD.version,
    tabletDraftId: `TABLET_DRAFT:${draftId}`,
    draftId,
    state: text(draft.state) || 'DRAFT',
    createdBy: text(draft.createdBy) || null,
    ownerSystem: text(draft.ownerSystem) || null,
    information: clone(draft.information || {}),
    inputRefs: Object.freeze([...(draft.inputRefs || [])]),
    decision: text(draft.decision) || null,
    review: clone(draft.review || null),
    workId: draft.workId || null,
    checkpointId: draft.checkpointId || null,
    savedBy: text(actor) || 'HERMES',
    station: TABLET_DRAFT_STANDARD.station,
    sourceSha: text(sourceSha) || 'UNKNOWN',
    savedAt,
    ownsWorkTruth: false,
    workCreated: Boolean(draft.workId),
    authorityCreated: false,
  });
}

export function createTabletRuntime({ bucket, sourceSha = 'UNKNOWN', now = () => new Date().toISOString() } = {}) {
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    const notConfigured = async () => Object.freeze({
      status: 'NOT_CONFIGURED',
      verified: false,
      reason: 'TABLET_STORAGE_NOT_CONFIGURED',
    });
    return Object.freeze({
      configured: false,
      issue: notConfigured,
      saveDraft: notConfigured,
    });
  }

  async function writeAndVerify({
    key,
    storageRef,
    body,
    customMetadata,
    verify,
    tablet,
    successStatus,
  }) {
    const checksum = await sha256(body);
    const written = await bucket.put(key, body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { ...customMetadata, checksum },
    });
    const stored = await bucket.get(key);
    if (!stored) {
      return Object.freeze({
        status: 'UNKNOWN',
        verified: false,
        reason: 'TABLET_R2_READBACK_MISSING',
        tablet,
        storageRef,
        key,
        checksum,
        etag: written?.etag || null,
      });
    }

    const readbackBody = await stored.text();
    const readbackChecksum = await sha256(readbackBody);
    let readback = null;
    try { readback = JSON.parse(readbackBody); } catch { /* fail closed below */ }
    const verified = readbackChecksum === checksum && verify(readback);

    return Object.freeze({
      status: verified ? successStatus : 'UNKNOWN',
      verified,
      reason: verified ? 'R2_WRITE_READBACK_VERIFIED' : 'TABLET_R2_READBACK_MISMATCH',
      tablet,
      storageRef,
      key,
      checksum,
      readbackChecksum,
      etag: written?.etag || stored?.etag || null,
      observedAt: now(),
    });
  }

  async function saveDraft(draft, { actor = 'HERMES' } = {}) {
    const manifest = draftManifestFor(draft, { actor, sourceSha, savedAt: now() });
    const body = JSON.stringify(manifest);
    const key = tabletDraftObjectKey({ draftId: manifest.draftId });
    const storageRef = tabletDraftStorageRef({ draftId: manifest.draftId });
    return writeAndVerify({
      key,
      storageRef,
      body,
      tablet: manifest,
      successStatus: 'DRAFT_SAVED',
      customMetadata: {
        schema: TABLET_DRAFT_STANDARD.schema,
        version: TABLET_DRAFT_STANDARD.version,
        draftId: manifest.draftId,
        state: manifest.state,
      },
      verify: readback => (
        readback?.schema === TABLET_DRAFT_STANDARD.schema
        && readback?.version === TABLET_DRAFT_STANDARD.version
        && readback?.draftId === manifest.draftId
        && readback?.state === manifest.state
      ),
    });
  }

  async function issue(record, { actor = 'HERMES' } = {}) {
    const manifest = manifestFor(record, { actor, sourceSha, issuedAt: now() });
    const body = JSON.stringify(manifest);
    const key = tabletObjectKey({
      workId: manifest.workId,
      checkpointId: manifest.checkpointId,
      kind: 'snapshot',
      name: 'tablet.json',
    });
    const storageRef = tabletStorageRef({
      workId: manifest.workId,
      checkpointId: manifest.checkpointId,
      kind: 'snapshot',
      name: 'tablet.json',
    });

    return writeAndVerify({
      key,
      storageRef,
      body,
      tablet: manifest,
      successStatus: 'ISSUED',
      customMetadata: {
        schema: TABLET_STANDARD.schema,
        version: TABLET_STANDARD.version,
        workId: manifest.workId,
        checkpointId: manifest.checkpointId,
        originDraftId: manifest.originDraftId || '',
      },
      verify: readback => (
        readback?.tabletId === manifest.tabletId
        && readback?.workId === manifest.workId
        && readback?.checkpointId === manifest.checkpointId
        && readback?.schema === TABLET_STANDARD.schema
        && readback?.version === TABLET_STANDARD.version
      ),
    });
  }

  return Object.freeze({ configured: true, issue, saveDraft });
}
