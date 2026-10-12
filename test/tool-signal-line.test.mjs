import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/city-runtime.mjs';
import { createToolSignalLine } from '../src/tool-signal-line.mjs';

const context = { actor: 'LIGHT', from: 'LIGHT', to: 'GO', workId: 'WORK-1', checkpointId: 'WORK-1:CP-01' };

test('ToolSignal EVENT keeps the enum stable and accepts typed TOOL_DONE with evidence', async () => {
  const line = createToolSignalLine({ store: createMemoryStore(), clock: () => '2026-10-12T16:00:00.000Z' });
  const signal = await line.send({
    ...context,
    kind: 'EVENT',
    messageId: 'evt-1',
    body: {
      schema: 'TOOL_EVENT_V1',
      eventType: 'TOOL_DONE',
      evidenceRefs: ['test://result'],
      checkpointRefs: { safeCandidateRef: 'checkpoint://candidate-1' },
    },
  });
  assert.equal(signal.signalKind, 'EVENT');
  assert.equal(signal.body.eventType, 'TOOL_DONE');
  assert.deepEqual(signal.body.checkpointRefs, { safeCandidateRef: 'checkpoint://candidate-1' });
  assert.equal(Object.hasOwn(signal, 'eventType'), false);
});

test('ToolSignal EVENT accepts ERROR capture and APPROVAL_REQUIRED reason payloads', async () => {
  const line = createToolSignalLine({ store: createMemoryStore() });
  const error = await line.send({
    ...context,
    kind: 'EVENT',
    messageId: 'evt-error',
    body: {
      schema: 'TOOL_EVENT_V1',
      eventType: 'ERROR',
      reason: 'provider timeout',
      checkpointRefs: { errorCaptureRef: 'log://capture-1' },
    },
  });
  assert.equal(error.body.eventType, 'ERROR');
  const approval = await line.send({
    ...context,
    kind: 'EVENT',
    messageId: 'evt-approval',
    body: {
      schema: 'TOOL_EVENT_V1',
      eventType: 'APPROVAL_REQUIRED',
      reason: 'scope expansion requested',
    },
  });
  assert.equal(approval.body.eventType, 'APPROVAL_REQUIRED');
});

test('ToolSignal EVENT rejects untyped, unscoped, or unsupported lifecycle events', async () => {
  const line = createToolSignalLine({ store: createMemoryStore() });
  const send = body => line.send({
    ...context, kind: 'EVENT', messageId: `bad-${Math.random()}`, body,
  });
  await assert.rejects(() => send({ eventType: 'TOOL_DONE', evidenceRefs: ['test://result'] }), /TOOL_EVENT_SCHEMA_INVALID/);
  await assert.rejects(() => send({
    schema: 'TOOL_EVENT_V1', eventType: 'COMPLETED', reason: 'must not be tool-owned',
  }), /TOOL_EVENT_TYPE_INVALID/);
  await assert.rejects(() => send({
    schema: 'TOOL_EVENT_V1', eventType: 'TOOL_DONE', evidenceRefs: [],
  }), /TOOL_DONE_EVIDENCE_REQUIRED/);
  await assert.rejects(() => line.send({
    ...context, workId: null, checkpointId: null, kind: 'EVENT', messageId: 'unscoped',
    body: { schema: 'TOOL_EVENT_V1', eventType: 'ERROR', reason: 'failure' },
  }), /TOOL_EVENT_WORK_CONTEXT_REQUIRED/);
  await assert.rejects(() => send({
    schema: 'TOOL_EVENT_V1', eventType: 'ERROR', reason: 'failure',
    checkpointRefs: { safeCandidateRef: 'checkpoint://candidate-1' },
  }), /SAFE_CANDIDATE_REF_EVENT_INVALID/);
});