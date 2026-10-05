import test from 'node:test';
import assert from 'node:assert/strict';
import { createCargoEnvelope, createDeliveryReceipt, createMailbox, deliverCargo, DELIVERY_STATUS, MAILBOX_STATUS, routeCargo } from '../src/post-office.mjs';

function envelope() {
  return createCargoEnvelope({ dataId: 'DATA-1', dataKind: 'ARTIFACT', payloadRef: 'artifact://factory/1', owner: 'GO', sender: 'FACTORY', receiver: 'GO', mailbox: 'MAILBOX-GO' });
}

test('Post Office preserves data identity and issues a receipt', () => {
  const mailbox = createMailbox({ mailboxId: 'MAILBOX-GO', owner: 'GO', receiver: 'GO' });
  const result = deliverCargo(envelope(), { mailbox, receiptId: 'RECEIPT-1', observedAt: '2026-10-05T18:00:00Z' });
  assert.equal(result.status, DELIVERY_STATUS.DELIVERED);
  assert.equal(result.receipt.dataId, 'DATA-1'); assert.equal(result.receipt.owner, 'GO'); assert.equal(result.receipt.sender, 'FACTORY');
  assert.equal(result.receipt.receiver, 'GO'); assert.equal(result.receipt.mailbox, 'MAILBOX-GO');
});

test('Post Office returns explicit unresolved, misrouted, and undeliverable states', () => {
  assert.equal(routeCargo(envelope(), {}).status, DELIVERY_STATUS.UNRESOLVED);
  const wrongMailbox = createMailbox({ mailboxId: 'MAILBOX-OTHER', owner: 'OTHER', receiver: 'OTHER' });
  assert.equal(routeCargo(envelope(), { mailbox: wrongMailbox }).status, DELIVERY_STATUS.MISROUTED);
  const closedMailbox = createMailbox({ mailboxId: 'MAILBOX-GO', owner: 'GO', receiver: 'GO', status: MAILBOX_STATUS.CLOSED });
  assert.equal(routeCargo(envelope(), { mailbox: closedMailbox }).status, DELIVERY_STATUS.UNDELIVERABLE);
});

test('Delivery receipt requires the original cargo identity', () => { assert.throws(() => createDeliveryReceipt(null, { receiptId: 'RECEIPT-1' }), /DATA_CARGO_ENVELOPE_REQUIRED/); });
