import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/city-runtime.mjs';
import { createWorkStateSignalLine, WORK_SIGNAL_STATUS } from '../src/work-state-signal.mjs';

test('HERMES and MIMIR are the only publishers on the work-state signal line', async () => {
  const line = createWorkStateSignalLine({ store: createMemoryStore(), clock: () => '2026-10-08T06:00:00Z' });
  await assert.rejects(() => line.publish({
    workId:'WORK-1', checkpointId:'CP-1', status:WORK_SIGNAL_STATUS.ONLINE, publisher:'PIXIE',
  }), /WORK_SIGNAL_PUBLISHER_NOT_ALLOWED/);
  await assert.rejects(() => line.publish({
    workId:'WORK-1', checkpointId:'CP-1', status:WORK_SIGNAL_STATUS.OFFLINE, publisher:'HERMES',
  }), /HERMES_SIGNAL_MUST_BE_ONLINE/);
  await assert.rejects(() => line.publish({
    workId:'WORK-1', checkpointId:'CP-1', status:WORK_SIGNAL_STATUS.ONLINE, publisher:'MIMIR',
  }), /MIMIR_SIGNAL_MUST_BE_OFFLINE/);
});

test('City Hall keeps a lightweight ordered projection per Work ID', async () => {
  let n = 0;
  const line = createWorkStateSignalLine({
    store: createMemoryStore(),
    clock: () => `2026-10-08T06:00:0${n++}Z`,
  });
  const online = await line.publish({
    workId:'WORK-1', checkpointId:'CP-1', status:'ONLINE', publisher:'HERMES', workState:'RECEIVED', reason:'NEW',
  });
  const offline = await line.publish({
    workId:'WORK-1', checkpointId:'CP-1', status:'OFFLINE', publisher:'MIMIR', workState:'COMPLETED', reason:'COMPLETE',
  });
  assert.equal(online.sequence, 1);
  assert.equal(offline.sequence, 2);
  assert.equal((await line.getCurrent('WORK-1')).status, 'OFFLINE');
  assert.deepEqual((await line.listHistory('WORK-1')).map(signal => signal.publisher), ['HERMES','MIMIR']);
  assert.equal(Object.hasOwn(offline, 'payload'), false);
  assert.equal(Object.hasOwn(offline, 'artifactRefs'), false);
  assert.equal(Object.hasOwn(offline, 'inputRefs'), false);
});
