import { tabletObjectKey, tabletStorageRef } from './tablet-storage.mjs';

export const TABLET_STANDARD = Object.freeze({
  schema: 'WORK_TABLET_V1',
  version: '1.0.0',
  issuer: 'HERMES',
  station: 'AGENT_ARRIVAL_STATION',
  ownsWorkTruth: false,
  mayCreateAuthority: false,
});

const text = value => String(value ?? '').trim();

async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function manifestFor(record = {}, { actor = 'HERMES', sourceSha = 'UNKNOWN', issuedAt = new Date().toISOString() } = {}) {
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

export function createTabletRuntime({ bucket, sourceSha = 'UNKNOWN', now = () => new Date().toISOString() } = {}) {
  if (!bucket || typeof bucket.put !== 'function' || typeof bucket.get !== 'function') {
    return Object.freeze({
      configured: false,
      async issue() {
        return Object.freeze({
          status: 'NOT_CONFIGURED',
          verified: false,
          reason: 'TABLET_STORAGE_NOT_CONFIGURED',
        });
      },
    });
  }

  async function issue(record, { actor = 'HERMES' } = {}) {
    const manifest = manifestFor(record, { actor, sourceSha, issuedAt: now() });
    const body = JSON.stringify(manifest);
    const checksum = await sha256(body);
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

    const written = await bucket.put(key, body, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        schema: TABLET_STANDARD.schema,
        version: TABLET_STANDARD.version,
        checksum,
        workId: manifest.workId,
        checkpointId: manifest.checkpointId,
      },
    });

    const stored = await bucket.get(key);
    if (!stored) {
      return Object.freeze({
        status: 'UNKNOWN',
        verified: false,
        reason: 'TABLET_R2_READBACK_MISSING',
        tablet: manifest,
        storageRef,
        key,
        checksum,
        etag: written?.etag || null,
      });
    }

    const readbackBody = await stored.text();
    const readbackChecksum = await sha256(readbackBody);
    let readbackManifest = null;
    try { readbackManifest = JSON.parse(readbackBody); } catch { /* fail closed below */ }

    const verified = readbackChecksum === checksum
      && readbackManifest?.tabletId === manifest.tabletId
      && readbackManifest?.workId === manifest.workId
      && readbackManifest?.checkpointId === manifest.checkpointId
      && readbackManifest?.schema === TABLET_STANDARD.schema
      && readbackManifest?.version === TABLET_STANDARD.version;

    return Object.freeze({
      status: verified ? 'ISSUED' : 'UNKNOWN',
      verified,
      reason: verified ? 'R2_WRITE_READBACK_VERIFIED' : 'TABLET_R2_READBACK_MISMATCH',
      tablet: manifest,
      storageRef,
      key,
      checksum,
      readbackChecksum,
      etag: written?.etag || stored?.etag || null,
      observedAt: now(),
    });
  }

  return Object.freeze({ configured: true, issue });
}
