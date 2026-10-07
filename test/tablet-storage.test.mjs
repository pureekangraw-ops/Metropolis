import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLET_STORAGE, tabletObjectKey, tabletStorageRef } from '../src/tablet-storage.mjs';

test('Tablet storage is isolated under the factory bucket Metropolis prefix', () => {
  assert.equal(TABLET_STORAGE.binding, 'TABLET_STORAGE');
  assert.equal(TABLET_STORAGE.bucket, 'factory');
  assert.equal(TABLET_STORAGE.prefix, 'metropolis/tablets/');
  assert.equal(TABLET_STORAGE.ownsWorkTruth, false);
});

test('Tablet object key preserves Work and Checkpoint identity', () => {
  const key = tabletObjectKey({
    workId: 'WORK-1',
    checkpointId: 'CP-1',
    kind: 'evidence',
    name: 'receipt.json',
  });
  assert.equal(key, 'metropolis/tablets/WORK-1/CP-1/evidence/receipt.json');
  assert.equal(
    tabletStorageRef({
      workId: 'WORK-1',
      checkpointId: 'CP-1',
      kind: 'snapshot',
      name: 'tablet.json',
    }),
    'r2://factory/metropolis/tablets/WORK-1/CP-1/snapshot/tablet.json',
  );
});
