export const POST_OFFICE_CONTRACT_VERSION = '1.0.0';

export const DELIVERY_STATUS = Object.freeze({
  UNRESOLVED: 'UNRESOLVED', ROUTED: 'ROUTED', DELIVERED: 'DELIVERED', MISROUTED: 'MISROUTED', UNDELIVERABLE: 'UNDELIVERABLE',
});

export const MAILBOX_STATUS = Object.freeze({ OPEN: 'OPEN', CLOSED: 'CLOSED', UNAVAILABLE: 'UNAVAILABLE' });

function text(value) { return String(value ?? '').trim(); }
function required(value, name) { const normalized = text(value); if (!normalized) throw new TypeError(`${name}_REQUIRED`); return normalized; }
function freeze(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function withStatus(envelope, status, reason) { return freeze({ ...envelope, status, reason: reason || null, updatedAt: new Date().toISOString() }); }

export function createMailbox({ mailboxId, owner, receiver, status = MAILBOX_STATUS.OPEN } = {}) {
  return freeze({ kind: 'MAILBOX', mailboxId: required(mailboxId, 'mailboxId'), owner: required(owner, 'owner'), receiver: required(receiver, 'receiver'), status: required(status, 'status') });
}

export function createCargoEnvelope({ dataId, dataKind, payloadRef, owner, sender, receiver, mailbox } = {}) {
  const now = new Date().toISOString();
  return freeze({ kind: 'DATA_CARGO', contractVersion: POST_OFFICE_CONTRACT_VERSION, dataId: required(dataId, 'dataId'), dataKind: required(dataKind, 'dataKind'), payloadRef: required(payloadRef, 'payloadRef'), owner: required(owner, 'owner'), sender: required(sender, 'sender'), receiver: required(receiver, 'receiver'), mailbox: required(mailbox, 'mailbox'), status: DELIVERY_STATUS.UNRESOLVED, reason: 'NOT_ROUTED', receipt: null, createdAt: now, updatedAt: now });
}

export function routeCargo(envelope, { mailbox } = {}) {
  if (!envelope || envelope.kind !== 'DATA_CARGO') throw new TypeError('DATA_CARGO_ENVELOPE_REQUIRED');
  if (!mailbox) return withStatus(envelope, DELIVERY_STATUS.UNRESOLVED, 'MAILBOX_NOT_FOUND');
  if (mailbox.mailboxId !== envelope.mailbox || mailbox.receiver !== envelope.receiver) return withStatus(envelope, DELIVERY_STATUS.MISROUTED, 'MAILBOX_RECEIVER_MISMATCH');
  if (mailbox.status !== MAILBOX_STATUS.OPEN) return withStatus(envelope, DELIVERY_STATUS.UNDELIVERABLE, 'MAILBOX_UNAVAILABLE');
  return withStatus(envelope, DELIVERY_STATUS.ROUTED, 'MAILBOX_RESOLVED');
}

export function createDeliveryReceipt(envelope, { receiptId, observedAt = new Date().toISOString() } = {}) {
  if (!envelope || envelope.kind !== 'DATA_CARGO') throw new TypeError('DATA_CARGO_ENVELOPE_REQUIRED');
  return freeze({ kind: 'DELIVERY_RECEIPT', receiptId: required(receiptId, 'receiptId'), dataId: envelope.dataId, owner: envelope.owner, sender: envelope.sender, receiver: envelope.receiver, mailbox: envelope.mailbox, observedAt: required(observedAt, 'observedAt') });
}

export function deliverCargo(envelope, { mailbox, receiptId, observedAt } = {}) {
  const routed = routeCargo(envelope, { mailbox });
  if (routed.status !== DELIVERY_STATUS.ROUTED) return routed;
  const receipt = createDeliveryReceipt(routed, { receiptId, observedAt });
  return freeze({ ...routed, status: DELIVERY_STATUS.DELIVERED, reason: 'DELIVERY_RECEIPT_ISSUED', receipt, updatedAt: receipt.observedAt });
}
