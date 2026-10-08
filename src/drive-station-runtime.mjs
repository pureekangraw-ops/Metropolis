// Direct Google Drive cargo adapter for the existing Metropolis DRIVE_STATION.
// This does not issue authority, move agents, or route via the legacy GO HUB.
// Provider credentials remain Cloudflare Worker secrets; cargo bytes stay in R2.
export const DRIVE_STATION_ID = 'DRIVE_STATION';
export const DRIVE_STATION_PROFILE = Object.freeze({
  stationId: DRIVE_STATION_ID,
  destinationId: 'GOOGLE_DRIVE',
  ownerSystem: 'GOOGLE_DRIVE',
  carriesPeople: false,
});
const enc = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
const digest = async bytes => hex(await crypto.subtle.digest('SHA-256', bytes));
const value = x => typeof x === 'string' ? x.trim() : '';
const verifyId = (x, label) => {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(value(x))) throw new Error(label + '_INVALID');
  return value(x);
};
const fatal = (code) => { throw new Error(code); };
const MIME = new Set(['application/json','text/plain','text/markdown','application/pdf','image/png','image/jpeg','application/zip','application/octet-stream']);
const KINDS = new Set(['DATA','ARTIFACT','EVIDENCE']);
const BASE = 'https://www.googleapis.com/drive/v3';
const TOKEN = 'https://oauth2.googleapis.com/token';
const MAX_BYTES = 2 * 1024 * 1024;

export function createDriveStationRuntime({
  bucket, clientId, clientSecret, refreshToken, folderId,
  fetchImpl = fetch, clock = () => new Date().toISOString(),
} = {}) {
  const configured = Boolean(bucket?.get && value(clientId) && value(clientSecret) && value(refreshToken) && value(folderId));
  const profile = DRIVE_STATION_PROFILE;

  async function token() {
    const data = new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId,
      client_secret: clientSecret, refresh_token: refreshToken,
    });
    const response = await fetchImpl(TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: data.toString(),
    });
    if (!response.ok) fatal('DRIVE_TOKEN_REFRESH_FAILED');
    const json = await response.json().catch(() => ({}));
    if (typeof json.access_token !== 'string' || !json.access_token) fatal('DRIVE_TOKEN_INVALID');
    return json.access_token;
  }

  async function api(url, auth, opts = {}) {
    const response = await fetchImpl(url, {
      ...opts,
      headers: { authorization: 'Bearer ' + auth, ...(opts.headers || {}) },
    });
    if (!response.ok) fatal('DRIVE_PROVIDER_RESPONSE_UNVERIFIED');
    return response;
  }

  async function readbackFile({ fileId, keyHash, sha256, auth }) {
    if (!/^[A-Za-z0-9_-]{5,160}$/.test(fileId)) fatal('DRIVE_FILE_ID_INVALID');
    const metadata = await (await api(BASE + '/files/' + encodeURIComponent(fileId)
      + '?fields=id,name,mimeType,parents,appProperties,trashed', auth)).json();
    if (metadata.trashed === true
      || !Array.isArray(metadata.parents) || !metadata.parents.includes(folderId)
      || metadata.appProperties?.metroCargoKey !== keyHash
      || metadata.appProperties?.metroSha256 !== sha256) fatal('DRIVE_IDENTITY_READBACK_MISMATCH');
    const response = await api(BASE + '/files/' + encodeURIComponent(fileId) + '?alt=media', auth);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES || await digest(bytes) !== sha256) fatal('DRIVE_CONTENT_READBACK_MISMATCH');
    return { verified: true, fileId, sha256, bytes: bytes.byteLength, observedAt: clock() };
  }


  function permitted({ workId, checkpointId, actor, operation, payload }) {
    const work = verifyId(workId, 'WORK_ID');
    const checkpoint = verifyId(checkpointId, 'CHECKPOINT_ID');
    if (operation !== 'ARCHIVE_CARGO') fatal('DRIVE_OPERATION_NOT_ALLOWED');
    if (!['GO','LIGHT'].includes(actor) || payload.workPass?.actor !== actor
      || payload.workPass?.workId !== work || payload.workPass?.checkpointId !== checkpoint
      || payload.workPass?.status !== 'ACTIVE'
      || !payload.workPass?.permissions?.handoff?.some(x => x.stationId === DRIVE_STATION_ID)
      || payload.workPassRef !== 'work-pass://' + payload.workPass?.passId) fatal('DRIVE_WORK_PASS_DENIED');
    if (!KINDS.has(payload.dataKind)) fatal('DRIVE_CARGO_KIND_INVALID');
    return { work, checkpoint };
  }

  async function stage({ workId, checkpointId, operation, payload = {}, actor } = {}) {
    if (!configured || !bucket?.put) fatal('DRIVE_STATION_NOT_CONFIGURED');
    const { work, checkpoint } = permitted({ workId, checkpointId, actor, operation, payload });
    const name = value(payload.fileName);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || name === '.' || name === '..')
      fatal('DRIVE_FILENAME_INVALID');
    if (typeof payload.content !== 'string') fatal('DRIVE_INLINE_CONTENT_INVALID');
    const mimeType = value(payload.mimeType || 'text/plain').toLowerCase();
    if (!MIME.has(mimeType)) fatal('DRIVE_MIME_NOT_ALLOWED');
    const bytes = enc.encode(payload.content);
    if (!bytes.byteLength || bytes.byteLength > 32768) fatal('DRIVE_INLINE_SIZE_INVALID');
    const key = 'metropolis/drive/outbox/' + work + '/' + checkpoint + '/' + name;
    const digestBefore = await digest(bytes);
    // Never replace an existing source object with different contents.
    const previous = await bucket.get(key);
    if (previous && await digest(await previous.arrayBuffer()) !== digestBefore)
      fatal('DRIVE_SOURCE_ALREADY_EXISTS');
    if (!previous) await bucket.put(key, bytes, {
      httpMetadata: { contentType: mimeType },
      customMetadata: { workId: work, checkpointId: checkpoint, sha256: digestBefore },
    });
    const saved = await bucket.get(key);
    if (!saved || await digest(await saved.arrayBuffer()) !== digestBefore)
      fatal('DRIVE_STAGE_R2_READBACK_MISMATCH');
    return Object.freeze({ payloadRef: 'r2://factory/' + key, sha256: digestBefore, bytes: bytes.byteLength });
  }

  async function handoff({ workId, checkpointId, operation, payload = {}, actor } = {}) {
    if (!configured) fatal('DRIVE_STATION_NOT_CONFIGURED');
    const { work, checkpoint } = permitted({ workId, checkpointId, actor, operation, payload });
    // Work-scoped R2 location prevents arbitrary reads from the shared R2 bucket.
    const root = 'metropolis/drive/outbox/' + work + '/' + checkpoint + '/';
    const ref = value(payload.payloadRef);
    if (!ref.startsWith('r2://factory/' + root)) fatal('DRIVE_CARGO_REF_INVALID');
    const objectKey = ref.slice('r2://factory/'.length);
    const name = objectKey.slice(root.length);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(name) || name === '.' || name === '..')
      fatal('DRIVE_FILENAME_INVALID');
    const object = await bucket.get(objectKey);
    if (!object) fatal('DRIVE_CARGO_NOT_FOUND');
    if (object.size > MAX_BYTES) fatal('DRIVE_CARGO_TOO_LARGE');
    const body = await object.arrayBuffer();
    if (!body.byteLength || body.byteLength > MAX_BYTES) fatal('DRIVE_CARGO_SIZE_INVALID');
    const mimeType = (object.httpMetadata?.contentType || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    if (!MIME.has(mimeType)) fatal('DRIVE_MIME_NOT_ALLOWED');
    const sha256 = await digest(body);
    const keyHash = await digest(enc.encode([work, checkpoint, payload.dataKind, objectKey].join('|')));
    const auth = await token();
    const q = "'" + folderId.replace(/'/g, "\\'") + "' in parents and trashed = false and appProperties has { key='metroCargoKey' and value='" + keyHash + "' }";
    const search = await (await api(BASE + '/files?' + new URLSearchParams({
      q, fields: 'nextPageToken,files(id,appProperties,parents,trashed)', pageSize: '20',
    }), auth)).json();
    if (search.nextPageToken || !Array.isArray(search.files) || search.files.length > 1)
      fatal('DRIVE_CARGO_DEDUP_UNCERTAIN');
    let fileId = search.files[0]?.id;
    if (!fileId) {
      const metadata = {
        name, mimeType, parents: [folderId],
        description: 'Metropolis POST OFFICE cargo; original source retained in R2',
        appProperties: { metroCargoKey: keyHash, metroSha256: sha256, metroWork: work, metroCheckpoint: checkpoint, metroKind: payload.dataKind },
      };
      const boundary = 'metro-' + crypto.randomUUID().replace(/-/g, '');
      const prefix = enc.encode('--' + boundary + '\r\nContent-Type: application/json; charset=utf-8\r\n\r\n'
        + JSON.stringify(metadata) + '\r\n--' + boundary + '\r\nContent-Type: ' + mimeType
        + '\r\n\r\n');
      const suffix = enc.encode('\r\n--' + boundary + '--\r\n');
      const multipart = new Uint8Array(prefix.length + body.byteLength + suffix.length);
      multipart.set(prefix, 0);
      multipart.set(new Uint8Array(body), prefix.length);
      multipart.set(suffix, prefix.length + body.byteLength);
      const created = await (await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', auth, {
        method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + boundary },
        body: multipart,
      })).json();
      fileId = created?.id;
      if (!fileId) fatal('DRIVE_UPLOAD_ID_MISSING');
    }
    const readback = await readbackFile({ fileId, keyHash, sha256, auth });
    return Object.freeze({
      verified: true, domainVerified: true, storageVerified: true, dataDeliveryOnly: true,
      stationId: DRIVE_STATION_ID, ownerSystem: 'GOOGLE_DRIVE',
      workId: work, checkpointId: checkpoint, workPassRef: payload.workPassRef,
      receiptId: 'drive:' + keyHash, providerFileId: fileId,
      evidenceRef: 'drive-evidence://' + keyHash + '/' + sha256,
      artifactRef: 'https://drive.google.com/file/d/' + encodeURIComponent(fileId) + '/view',
      sha256, bytes: readback.bytes, cargoKind: payload.dataKind, observedAt: readback.observedAt,
    });
  }
  async function readback({ workId, checkpointId, handoff } = {}) {
    if (!configured) fatal('DRIVE_STATION_NOT_CONFIGURED');
    const external = handoff?.external;
    if (!external?.storageVerified || external?.workId !== workId || external?.checkpointId !== checkpointId)
      fatal('DRIVE_RECEIPT_SCOPE_MISMATCH');
    const auth = await token();
    const confirmed = await readbackFile({
      fileId: external.providerFileId,
      keyHash: external.receiptId?.slice('drive:'.length),
      sha256: external.sha256, auth,
    });
    return Object.freeze({
      verified: true, domainVerified: true, storageVerified: true,
      stationId: DRIVE_STATION_ID, workId, checkpointId,
      workPassRef: external.workPassRef,
      evidenceRef: external.evidenceRef, receiptId: external.receiptId,
      result: { artifactRefs: [external.artifactRef], evidenceRefs: [external.evidenceRef], workPassRef: external.workPassRef },
      readbackSha256: confirmed.sha256, observedAt: confirmed.observedAt,
    });
  }
  return Object.freeze({ configured, profile, stage, handoff, readback });
}
