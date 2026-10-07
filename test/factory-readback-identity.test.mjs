import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryRailAdapter } from '../src/stations/factory.mjs';

const payload = { workId: 'WORK-1', checkpointId: 'CP-1', expectedSourceSha: 'sha-1' };
const valid = { receiptId: 'receipt-1', workId: 'WORK-1', checkpointId: 'CP-1', sourceSha: 'sha-1', stationId: 'FACTORY-STATION', boundaryVerified: true, evidenceRef: 'evidence://1' };
for (const [field, value] of Object.entries({ workId: 'OTHER', checkpointId: 'OTHER', sourceSha: 'OLD', stationId: 'OTHER' })) {
  test(`Factory readback rejects mismatched ${field}`, async () => {
    const adapter = createFactoryRailAdapter({ baseUrl: 'https://factory.example', sharedSecret: 'secret', fetchImpl: async () => Response.json({ ...valid, [field]: value }) });
    const result = await adapter.readback({ transport: { payload }, receipt: { receiptId: 'receipt-1' } });
    assert.equal(result.verified, false);
    assert.equal(result.evidenceRef, null);
  });
}
test('Factory readback accepts correlated identity and version', async () => {
  const adapter = createFactoryRailAdapter({ baseUrl: 'https://factory.example', sharedSecret: 'secret', fetchImpl: async () => Response.json(valid) });
  assert.equal((await adapter.readback({ transport: { payload }, receipt: { receiptId: 'receipt-1' } })).verified, true);
});
