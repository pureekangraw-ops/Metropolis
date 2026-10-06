export const CONNECTION_STATE = Object.freeze({ DISCONNECTED: 'DISCONNECTED', CONNECTED: 'CONNECTED', RECEIVE: 'RECEIVE', REGISTER: 'REGISTER', DELIVER: 'DELIVER', ACK: 'ACK', RETURN: 'RETURN', COMPLETE: 'COMPLETE', UNKNOWN: 'UNKNOWN', UNAVAILABLE: 'UNAVAILABLE' });

function required(value, name) { if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`); return value.trim(); }
function copy(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function createAgentConnection({ agentId, secretaryId, mailboxId, role } = {}) {
  const identity = Object.freeze({ kind: 'AGENT_CONNECTION', agentId: required(agentId, 'agentId'), secretaryId: required(secretaryId, 'secretaryId'), mailboxId: required(mailboxId, 'mailboxId'), role: required(role, 'role') });
  let state = CONNECTION_STATE.DISCONNECTED;
  let sequence = 0;
  const history = [];
  const record = (next, data = {}) => { state = next; sequence += 1; history.push({ sequence, state: next, ...copy(data) }); return snapshot(); };
  const snapshot = () => copy({ ...identity, state, sequence, history });
  return Object.freeze({
    connect(data = {}) { return record(CONNECTION_STATE.CONNECTED, data); },
    disconnect(data = {}) { return record(CONNECTION_STATE.DISCONNECTED, data); },
    receive(data = {}) { return record(CONNECTION_STATE.RECEIVE, data); },
    register(data = {}) { return record(CONNECTION_STATE.REGISTER, data); },
    deliver(data = {}) { return record(CONNECTION_STATE.DELIVER, data); },
    acknowledge(data = {}) { return record(CONNECTION_STATE.ACK, data); },
    returnConnection(data = {}) { return record(CONNECTION_STATE.RETURN, data); },
    complete(data = {}) { return record(CONNECTION_STATE.COMPLETE, data); },
    unavailable(data = {}) { return record(CONNECTION_STATE.UNAVAILABLE, data); },
    unknown(data = {}) { return record(CONNECTION_STATE.UNKNOWN, data); },
    snapshot,
  });
}
