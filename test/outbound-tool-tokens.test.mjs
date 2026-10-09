import test from 'node:test';
import assert from 'node:assert/strict';
import { createOutboundToolTokenManager } from '../src/outbound-tool-tokens.mjs';

const key = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const request = { actor: 'GO', workId: 'WORK-1', checkpointId: 'CP-1',
  stationId: 'SERVICE_STATION', operation: 'READ', providerId: 'service' };
function store() {
  const values = new Map();
  return {
    values,
    async get(k) { return structuredClone(values.get(k)); },
    async transaction(f) { return f({
      get: async k => structuredClone(values.get(k)),
      put: async (k,v) => values.set(k, structuredClone(v)),
    }); },
  };
}
test('outbound renewal rotates credential with encrypted storage', async () => {
  const durable = store();
  let time = 1000000000000;
  let calls = 0;
  const manager = createOutboundToolTokenManager({
    store: durable, encryptionKey: key, now: () => time,
    providers: { service: { stationId: 'SERVICE_STATION',
      tokenEndpoint: 'https://provider.example/oauth/token',
      clientId: 'test-client', clientSecret: 'test-only-value' } },
    authorize: async () => ({ allowed: true }),
    fetchImpl: async (_url, opts) => {
      calls++;
      assert.equal(opts.body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'access-two',
        refresh_token: 'refresh-two', token_type: 'Bearer',
        expires_in: 3600 });
    },
  });
  await manager.provision(request, { accessToken: 'access-one', refreshToken: 'refresh-one', expiresAt: time + 100000 });
  assert.equal(await manager.getAccessToken(request), 'access-one');
  time += 45000;
  assert.equal(await manager.getAccessToken(request), 'access-two');
  assert.equal(calls, 1);
  assert.equal((await manager.status(request)).lastOutcome, 'ROTATED');
  assert.equal(JSON.stringify([...durable.values.values()]).includes('refresh-one'), false);
});
