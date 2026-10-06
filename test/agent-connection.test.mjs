import test from 'node:test';
import assert from 'node:assert/strict';
import { CONNECTION_STATE, createAgentConnection } from '../src/agent-connection.mjs';

test('Agent connection can connect and disconnect without changing city infrastructure', () => {
  const connection = createAgentConnection({ agentId: 'GO', secretaryId: 'SEC-GO', mailboxId: 'MAILBOX-GO', role: 'ACTOR' });
  assert.equal(connection.connect().state, CONNECTION_STATE.CONNECTED);
  assert.equal(connection.disconnect().state, CONNECTION_STATE.DISCONNECTED);
  assert.equal(connection.snapshot().mailboxId, 'MAILBOX-GO');
});

test('Secretary connection lifecycle is distinct from cargo delivery lifecycle', () => {
  const connection = createAgentConnection({ agentId: 'LIGHT', secretaryId: 'SEC-LIGHT', mailboxId: 'MAILBOX-LIGHT', role: 'ACTOR' });
  assert.equal(connection.receive({ dataId: 'DATA-1' }).state, CONNECTION_STATE.RECEIVE);
  assert.equal(connection.acknowledge({ dataId: 'DATA-1' }).state, CONNECTION_STATE.ACK);
  assert.equal(connection.snapshot().history[1].state, CONNECTION_STATE.ACK);
});
