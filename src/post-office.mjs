export const POST_OFFICE_CONTRACT_VERSION = '1.1.0';
export const DELIVERY_STATUS = Object.freeze({ UNRESOLVED: 'UNRESOLVED', ROUTED: 'ROUTED', DELIVERED: 'DELIVERED', ACKNOWLEDGED: 'ACKNOWLEDGED', RETURNED: 'RETURNED', RETRYING: 'RETRYING', MISROUTED: 'MISROUTED', UNDELIVERABLE: 'UNDELIVERABLE', UNKNOWN: 'UNKNOWN' });
export const MAILBOX_STATUS = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED', UNAVAILABLE: 'UNAVAILABLE' });
function text(value) { return String(value ?? '').trim(); }
function required(value, name) { const normalized = text(value); if (!normalized) throw new TypeError(`${name}_REQUIRED`); return normalized; }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function withStatus(envelope, status, reason) { return freeze({ ...envelope, deliveryState: status, status, reason: reason || null, updatedAt: new Date().toISOString() }); }

export function createMailbox({ mailboxId, owner, receiver, status = MAILBOX_STATUS.OPEN } = {}) { return freeze({ kind: 'MAILBOX', mailboxId: required(mailboxId, 'mailboxId'), owner: required(owner, 'owner'), receiver: required(receiver, 'receiver'), status: required(status, 'status') }); }
export function createCargoEnvelope({ dataId, dataKind, payloadRef, owner, sender, receiver, mailbox, destination = receiver, workId = null, checkpointId = null } = {}) {
  const now = new Date().toISOString();
  return freeze({ kind: 'DATA_CARGO', contractVersion: POST_OFFICE_CONTRACT_VERSION, dataId: required(dataId, 'dataId'), dataKind: required(dataKind, 'dataKind'), payloadRef: required(payloadRef, 'payloadRef'), owner: required(owner, 'owner'), sender: required(sender, 'sender'), receiver: required(receiver, 'receiver'), mailbox: required(mailbox, 'mailbox'), destination: required(destination, 'destination'), workId: workId == null ? null : required(workId, 'workId'), checkpointId: checkpointId == null ? null : required(checkpointId, 'checkpointId'), deliveryState: DELIVERY_STATUS.UNRESOLVED, status: DELIVERY_STATUS.UNRESOLVED, reason: 'NOT_ROUTED', receipt: null, createdAt: now, updatedAt: now });
}
export function routeCargo(envelope, { mailbox } = {}) {
  if (!envelope || envelope.kind !== 'DATA_CARGO') throw new TypeError('DATA_CARGO_ENVELOPE_REQUIRED');
  if (!mailbox) return withStatus(envelope, DELIVERY_STATUS.UNRESOLVED, 'MAILBOX_NOT_FOUND');
  if (mailbox.mailboxId !== envelope.mailbox || mailbox.receiver !== envelope.receiver || mailbox.owner !== envelope.destination) return withStatus(envelope, DELIVERY_STATUS.MISROUTED, 'MAILBOX_DESTINATION_MISMATCH');
  if (mailbox.status !== MAILBOX_STATUS.OPEN) return withStatus(envelope, DELIVERY_STATUS.UNDELIVERABLE, 'MAILBOX_UNAVAILABLE');
  return withStatus(envelope, DELIVERY_STATUS.ROUTED, 'MAILBOX_RESOLVED');
}
export function createDeliveryReceipt(envelope, { receiptId, observedAt = new Date().toISOString() } = {}) {
  if (!envelope || envelope.kind !== 'DATA_CARGO') throw new TypeError('DATA_CARGO_ENVELOPE_REQUIRED');
  return freeze({ kind: 'DELIVERY_RECEIPT', receiptId: required(receiptId, 'receiptId'), dataId: envelope.dataId, dataKind: envelope.dataKind, owner: envelope.owner, sender: envelope.sender, receiver: envelope.receiver, mailbox: envelope.mailbox, destination: envelope.destination, workId: envelope.workId, checkpointId: envelope.checkpointId, observedAt: required(observedAt, 'observedAt') });
}
export function deliverCargo(envelope, { mailbox, receiptId, observedAt } = {}) { const routed = routeCargo(envelope, { mailbox }); if (routed.status !== DELIVERY_STATUS.ROUTED) return routed; const receipt = createDeliveryReceipt(routed, { receiptId, observedAt }); return freeze({ ...routed, deliveryState: DELIVERY_STATUS.DELIVERED, status: DELIVERY_STATUS.DELIVERED, reason: 'DELIVERY_RECEIPT_ISSUED', receipt, updatedAt: receipt.observedAt }); }
export function acknowledgeCargo(envelope, { observedAt = new Date().toISOString() } = {}) { if (!envelope?.receipt) return withStatus(envelope, DELIVERY_STATUS.UNKNOWN, 'RECEIPT_REQUIRED'); return withStatus(envelope, DELIVERY_STATUS.ACKNOWLEDGED, 'RECEIVER_ACKNOWLEDGED'); }
export function returnCargo(envelope, { destination, receiptId, observedAt } = {}) { const returned = createCargoEnvelope({ ...envelope, receiver: envelope.sender, sender: envelope.receiver, mailbox: envelope.mailbox, destination: destination || envelope.sender }); return freeze({ ...returned, deliveryState: DELIVERY_STATUS.RETURNED, status: DELIVERY_STATUS.RETURNED, receipt: envelope.receipt || createDeliveryReceipt(envelope, { receiptId, observedAt }), reason: 'CARGO_RETURNED', updatedAt: observedAt || new Date().toISOString() }); }
export function retryCargo(envelope, { observedAt = new Date().toISOString() } = {}) { return withStatus(envelope, DELIVERY_STATUS.RETRYING, 'DELIVERY_RETRY_REQUESTED'); }
