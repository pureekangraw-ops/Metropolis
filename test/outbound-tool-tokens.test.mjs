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


test('unauthorized Work cannot use, inspect or provision tool credentials', async () => {
  const durable = store();
  let providerCalls = 0;
  const manager = createOutboundToolTokenManager({
    store: durable, encryptionKey: key, now: () => 1000000000000,
    providers: { service: { stationId: 'SERVICE_STATION',
      tokenEndpoint: 'https://provider.example/oauth/token',
      clientId: 'test-client', clientSecret: 'test-only-value' } },
    authorize: async c => ({ allowed: c.actor === 'GO' && c.workId === 'WORK-1' && c.operation === 'READ' }),
    fetchImpl: async () => { providerCalls++; throw Error('must not contact provider'); },
  });
  const invalid = { ...request, actor: 'LIGHT' };
  for (const op of [() => manager.provision(invalid, { accessToken: 'a', refreshToken: 'b', expiresAt: 1000000100000 }),
    () => manager.getAccessToken(invalid), () => manager.status(invalid)]) {
    await assert.rejects(op, /OUTBOUND_WORK_PERMISSION_DENIED/);
  }
  await assert.rejects(manager.getAccessToken({ ...request, stationId: 'OTHER_STATION' }), /OUTBOUND_PROVIDER_STATION_MISMATCH/);
  await assert.rejects(manager.getAccessToken(request), /OUTBOUND_NOT_CONNECTED/);
  assert.equal(providerCalls, 0);
});

test('uncertain refresh fails closed without replaying a possibly consumed token', async () => {
  const durable = store();
  let calls = 0;
  const manager = createOutboundToolTokenManager({
    store: durable, encryptionKey: key, now: () => 1000000000000,
    providers: { service: { stationId: 'SERVICE_STATION',
      tokenEndpoint: 'https://provider.example/oauth/token',
      clientId: 'test-client', clientSecret: 'test-only-value' } },
    authorize: async () => ({ allowed: true }),
    fetchImpl: async () => { calls++; throw Error('unconfirmed exchange'); },
  });
  await manager.provision(request, { accessToken: 'a', refreshToken: 'b', expiresAt: 1000000020000 });
  await assert.rejects(manager.getAccessToken(request), /OUTBOUND_TOKEN_REFRESH_FAILED/);
  await assert.rejects(manager.getAccessToken(request), /OUTBOUND_REAUTH_REQUIRED/);
  assert.equal(calls, 1);
  assert.equal((await manager.status(request)).status, 'REAUTH_REQUIRED');
});


test('concurrent tool calls never redeem the same refresh token twice', async () => {
  const durable = store();
  let release;
  let calls = 0;
  const manager = createOutboundToolTokenManager({
    store: durable, encryptionKey: key, now: () => 1000000000000,
    providers: { service: { stationId: 'SERVICE_STATION',
      tokenEndpoint: 'https://provider.example/oauth/token',
      clientId: 'test-client', clientSecret: 'test-only-value' } },
    authorize: async () => ({ allowed: true }),
    fetchImpl: async () => {
      calls++;
      return new Promise(resolve => { release = () => resolve(Response.json({
        access_token: 'next-access', refresh_token: 'next-refresh',
        token_type: 'Bearer', expires_in: 3600,
      })); });
    },
  });
  await manager.provision(request, { accessToken: 'a', refreshToken: 'b', expiresAt: 1000000020000 });
  const first = manager.getAccessToken(request);
  for (let i = 0; i < 30 && !release; i++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  await assert.rejects(manager.getAccessToken(request), /OUTBOUND_REFRESH_IN_PROGRESS/);
  release();
  assert.equal(await first, 'next-access');
  assert.equal(calls, 1);
  assert.equal(await manager.getAccessToken(request), 'next-access');
});

test('incorrect provider scope blocks rotation and requires reauthorization', async () => {
  const durable = store();
  const manager = createOutboundToolTokenManager({
    store: durable, encryptionKey: key, now: () => 1000000000000,
    providers: { service: { stationId: 'SERVICE_STATION',
      tokenEndpoint: 'https://provider.example/oauth/token',
      clientId: 'test-client', clientSecret: 'test-only-value' } },
    authorize: async () => ({ allowed: true }),
    fetchImpl: async () => Response.json({
      access_token: 'widened-access', refresh_token: 'widened-refresh',
      token_type: 'Bearer', expires_in: 3600, scope: 'admin',
    }),
  });
  await manager.provision(request, {
    accessToken: 'a', refreshToken: 'b', scope: 'read', expiresAt: 1000000020000,
  });
  await assert.rejects(manager.getAccessToken(request), /OUTBOUND_TOKEN_SCOPE_CHANGED/);
  assert.equal((await manager.status(request)).status, 'REAUTH_REQUIRED');
});
