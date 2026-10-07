export const TABLET_STORAGE = Object.freeze({
  binding: 'TABLET_STORAGE',
  bucket: 'factory',
  prefix: 'metropolis/tablets/',
  ownsWorkTruth: false,
  stores: Object.freeze(['CONTEXT', 'ARTIFACT', 'EVIDENCE', 'SNAPSHOT']),
});

const clean = value => String(value ?? '').trim().replace(/^\/+|\/+$/g, '');

export function tabletObjectKey({
  workId,
  checkpointId,
  kind = 'snapshot',
  name = 'tablet.json',
} = {}) {
  const w = clean(workId);
  const c = clean(checkpointId);
  const k = clean(kind).toLowerCase();
  const n = clean(name);
  if (!w) throw new Error('WORK_ID_REQUIRED');
  if (!c) throw new Error('CHECKPOINT_ID_REQUIRED');
  if (!k) throw new Error('TABLET_KIND_REQUIRED');
  if (!n) throw new Error('TABLET_NAME_REQUIRED');
  return `${TABLET_STORAGE.prefix}${w}/${c}/${k}/${n}`;
}

export function tabletStorageRef(input = {}) {
  return `r2://${TABLET_STORAGE.bucket}/${tabletObjectKey(input)}`;
}
