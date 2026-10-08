import { inspectWorkPass, workPassAllowsHandoff } from './work-pass.mjs';

export const DRIVE_STATION_PROFILE = Object.freeze({
  stationId: 'DRIVE_STATION',
  destinationId: 'GOOGLE_DRIVE',
  ownerSystem: 'GOOGLE_DRIVE',
  transport: 'DATA_CARGO_ONLY',
  operations: Object.freeze(['ARCHIVE_DATA']),
  deletesSource: false,
});

export const DRIVE_MAX_CARGO_BYTES = 8 * 1024 * 1024;
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN = 'https://oauth2.googleapis.com/token';
const BUCKET = 'factory';
const SAFE_ID = /^[A-Za-z0-9:_-]{1,240}$/;

const text = value => String(value ?? '').trim();
const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
async function sha256(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}
function fail(reason) { throw new Error(reason); }
function validId(id, reason) {
  const value = text(id);
  if (!SAFE_ID.test(value)) fail(reason);
  return value;
}
function sourceKey(payloadRef, workId, checkpointId) {
  const prefix = 'r2://' + BUCKET + '/';
  const ref = text(payloadRef);
  if (!ref.startsWith(prefix)) fail('DRIVE_SOURCE_REF_INVALID');
  const key = ref.slice(prefix.length);
  const allowed = [
    'metropolis/tablets/' + workId + '/' + checkpointId + '/',
    'metropolis/post-office/' + workId + '/' + checkpointId + '/',
  ];
  if (!allowed.some(path => key.startsWith(path))) fail('DRIVE_SOURCE_OUTSIDE_WORK');
  if (key.length > 1000 || key.includes('\\') || key.includes('%') || key.includes('\0')
    || key.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    fail('DRIVE_SOURCE_REF_INVALID');
  }
  return key;
}
function driveFileId(value) {
  const id = text(value);
  if (!/^[A-Za-z0-9_-]{8,160}$/.test(id)) fail('DRIVE_PROVIDER_ID_INVALID');
  return id;
}
function fileRef(id) { return 'https://drive.google.com/file/d/' + encodeURIComponent(id) + '/view'; }
function safeFileName(key, workId) {
  const file = key.split('/').at(-1);
  const name = file.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 110) || 'cargo.bin';
  return workId.slice(0, 50) + '--' + name;
}
function configuredClient(config) {
  return Boolean(config.bucket?.get && text(config.clientId) && text(config.clientSecret)
    && text(config.refreshToken) && /^[A-Za-z0-9_-]{8,160}$/.test(text(config.folderId)));
}

export function createDriveStationRuntime({
  bucket,
  clientId,
  clientSecret,
  refreshToken,
  folderId,
  sourceSha = 'UNKNOWN',
  fetchImpl = fetch,
  now = () => new Date().toISOString(),
} = {}) {
  const configured = configuredClient({ bucket, clientId, clientSecret, refreshToken, folderId });
  const status = () => Object.freeze({ stationId: DRIVE_STATION_PROFILE.stationId, configured, transport: 'DATA_CARGO_ONLY' });

  async function providerRequest(url, { method = 'GET', token, headers = {}, body } = {}) {
    const response = await fetchImpl(url, {
      method,
      headers: { authorization: 'Bearer ' + token, ...headers },
      ...(body === undefined ? {} : { body }),
    });
    if (!response.ok) fail('DRIVE_PROVIDER_HTTP_' + response.status);
    return response;
  }
  async function accessToken() {
    if (!configured) fail('DRIVE_STATION_NOT_CONFIGURED');
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const response = await fetchImpl(TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) fail('DRIVE_OAUTH_REFRESH_FAILED');
    const data = await response.json().catch(() => ({}));
    if (!text(data.access_token)) fail('DRIVE_OAUTH_REFRESH_FAILED');
    return data.access_token;
  }

  async function readSource(ref, workId, checkpointId) {
    const key = sourceKey(ref, workId, checkpointId);
    const stored = await bucket.get(key);
    if (!stored) fail('DRIVE_SOURCE_NOT_FOUND');
    if (Number(stored.size) > DRIVE_MAX_CARGO_BYTES) fail('DRIVE_SOURCE_TOO_LARGE');
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (!bytes.length || bytes.byteLength > DRIVE_MAX_CARGO_BYTES) fail('DRIVE_SOURCE_INVALID_SIZE');
    const contentType = text(stored.httpMetadata?.contentType).split(';')[0];
    const mimeType = /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(contentType)
      ? contentType : 'application/octet-stream';
    return { bytes, key, mimeType, sha256: await sha256(bytes) };
  }

  async function findExisting(token, cargoKey) {
    const q = "'" + folderId + "' in parents and trashed = false and appProperties has { key='metropolisCargoKey' and value='" + cargoKey + "' }";
    const url = API + '/files?' + new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,appProperties,parents)',
      pageSize: '10',
    });
    const response = await providerRequest(url, { token });
    const result = await response.json().catch(() => ({}));
    if (!Array.isArray(result.files) || result.nextPageToken) fail('DRIVE_LOOKUP_UNVERIFIED');
    if (result.files.length > 1) fail('DRIVE_DUPLICATE_CARGO');
    return result.files.length ? driveFileId(result.files[0].id) : null;
  }

  async function upload(token, { source, workId, checkpointId, cargoKey }) {
    const boundary = 'metro-post-office-' + crypto.randomUUID().replace(/-/g, '');
    const metadata = {
      name: safeFileName(source.key, workId),
      parents: [folderId],
      mimeType: source.mimeType,
      appProperties: {
        metropolisCargoKey: cargoKey,
        workId,
        checkpointId,
        contentSha256: source.sha256,
        sourceSha: text(sourceSha),
      },
    };
    const blob = new Blob([
      '--' + boundary + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n',
      JSON.stringify(metadata),
      '\r\n--' + boundary + '\r\nContent-Type: ' + source.mimeType + '\r\n\r\n',
      source.bytes,
      '\r\n--' + boundary + '--\r\n',
    ]);
    const response = await providerRequest(UPLOAD + '?uploadType=multipart&fields=id', {
      token, method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + boundary }, body: blob,
    });
    const result = await response.json().catch(() => ({}));
    return driveFileId(result.id);
  }

  async function verifyFile(token, { fileId, source, workId, checkpointId, cargoKey, expectedSourceSha }) {
    const metadataResponse = await providerRequest(
      API + '/files/' + encodeURIComponent(fileId) + '?fields=id,mimeType,parents,appProperties,trashed',
      { token },
    );
    const metadata = await metadataResponse.json().catch(() => ({}));
    const p = metadata.appProperties || {};
    if (metadata.id !== fileId || metadata.trashed === true
      || !Array.isArray(metadata.parents) || !metadata.parents.includes(folderId)
      || p.metropolisCargoKey !== cargoKey
      || p.workId !== workId || p.checkpointId !== checkpointId
      || p.contentSha256 !== source.sha256 || p.sourceSha !== expectedSourceSha
      || metadata.mimeType !== source.mimeType) fail('DRIVE_METADATA_MISMATCH');
    const media = await providerRequest(API + '/files/' + encodeURIComponent(fileId) + '?alt=media', { token });
    const bytes = new Uint8Array(await media.arrayBuffer());
    if (bytes.byteLength !== source.bytes.byteLength || await sha256(bytes) !== source.sha256) {
      fail('DRIVE_READBACK_MISMATCH');
    }
    return { verified: true, sourceRef: 'r2://' + BUCKET + '/' + source.key,
      contentSha256: source.sha256, fileId, providerRef: fileRef(fileId) };
  }

  async function handoff({ workId, checkpointId, operation, actor, payload = {} } = {}) {
    if (!configured) fail('DRIVE_STATION_NOT_CONFIGURED');
    if (operation !== 'ARCHIVE_DATA') fail('DRIVE_OPERATION_NOT_ALLOWED');
    const id = validId(workId, 'DRIVE_WORK_ID_INVALID');
    const cp = validId(checkpointId, 'DRIVE_CHECKPOINT_ID_INVALID');
    const inspection = inspectWorkPass(payload.workPass, {
      workId: id, checkpointId: cp, actor, workState: 'HANDED_OFF',
    });
    if (!inspection.valid || !inspection.actions.includes('handoff')
      || !workPassAllowsHandoff(payload.workPass, {
        workId: id, checkpointId: cp, actor, stationId: 'DRIVE_STATION',
      })) fail('DRIVE_WORK_PASS_NOT_GRANTED');
    if (payload.workPassRef !== 'work-pass://' + payload.workPass.passId) fail('DRIVE_WORK_PASS_REF_MISMATCH');
    if (!text(payload.payloadRef)) fail('DRIVE_PAYLOAD_REF_REQUIRED');
    const source = await readSource(payload.payloadRef, id, cp);
    const cargoKey = await sha256(new TextEncoder().encode(id + '\0' + cp + '\0' + payload.payloadRef + '\0' + source.sha256));
    const token = await accessToken();
    const existing = await findExisting(token, cargoKey);
    const fileId = existing || await upload(token, { source, workId: id, checkpointId: cp, cargoKey });
    const proof = await verifyFile(token, {
      fileId, source, workId: id, checkpointId: cp, cargoKey, expectedSourceSha: text(sourceSha),
    });
    return Object.freeze({
      verified: true,
      boundaryVerified: true,
      providerVerified: true,
      domainVerified: true,
      operation: 'ARCHIVE_DATA',
      receiptId: 'GOOGLE_DRIVE:' + fileId,
      workId: id,
      checkpointId: cp,
      workPassRef: payload.workPassRef,
      sourceSha: text(sourceSha),
      sourceRef: proof.sourceRef,
      contentSha256: proof.contentSha256,
      providerRef: proof.providerRef,
      evidenceRef: 'drive-proof://' + proof.fileId + '/' + proof.contentSha256,
      fileId,
      cargoKey,
      sourcePreserved: true,
      observedAt: now(),
    });
  }

  async function readback({ workId, checkpointId, handoff: original } = {}) {
    if (!configured) fail('DRIVE_STATION_NOT_CONFIGURED');
    const external = original?.external;
    const id = validId(workId, 'DRIVE_WORK_ID_INVALID');
    const cp = validId(checkpointId, 'DRIVE_CHECKPOINT_ID_INVALID');
    if (!external?.fileId || external.workId !== id || external.checkpointId !== cp
      || original?.workPassRef !== external.workPassRef
      || original?.stationId !== 'DRIVE_STATION') fail('DRIVE_RECEIPT_IDENTITY_MISMATCH');
    const source = await readSource(external.sourceRef, id, cp);
    if (source.sha256 !== external.contentSha256) fail('DRIVE_SOURCE_CHECKSUM_CHANGED');
    const token = await accessToken();
    const proof = await verifyFile(token, {
      fileId: driveFileId(external.fileId), source, workId: id,
      checkpointId: cp, cargoKey: external.cargoKey, expectedSourceSha: external.sourceSha,
    });
    return Object.freeze({
      verified: true, domainVerified: true, providerVerified: true,
      receiptId: external.receiptId, workId: id, checkpointId: cp,
      workPassRef: external.workPassRef,
      stationId: 'DRIVE_STATION',
      sourceSha: external.sourceSha,
      evidenceRef: 'drive-proof://' + proof.fileId + '/' + proof.contentSha256,
      contentSha256: proof.contentSha256,
      result: {
        workId: id, checkpointId: cp, workPassRef: external.workPassRef,
        artifactRefs: [proof.providerRef],
        sourcePreserved: true,
      },
      observedAt: now(),
    });
  }

  return Object.freeze({ configured, status, profile: DRIVE_STATION_PROFILE, handoff, readback });
}
