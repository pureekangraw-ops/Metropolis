import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubRailAdapter } from '../src/stations/github.mjs';

test('GitHub probe does not infer write capability from token presence', async () => {
  const adapter = createGitHubRailAdapter({
    owner: 'owner',
    repo: 'repo',
    token: 'runtime-token',
    fetchImpl: async () => new Response(JSON.stringify({ id: 1, name: 'repo' }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const snapshot = await adapter.probe({ station: { stationId: 'STATION-GITHUB', ownerSystem: 'GITHUB' }, rail: { railId: 'RAIL-GITHUB' } });
  assert.equal(snapshot.status, 'READY');
  assert.equal(snapshot.scope.includes('CREATE_BRANCH'), false);
  assert.deepEqual(snapshot.capabilities.CREATE_BRANCH, { status: 'UNKNOWN', reason: 'WRITE_PERMISSION_UNVERIFIED' });
});

test('GitHub probe advertises branch creation only with confirmed repository push permission', async () => {
  const adapter = createGitHubRailAdapter({
    owner: 'owner',
    repo: 'repo',
    token: 'runtime-token',
    fetchImpl: async () => new Response(JSON.stringify({ id: 1, permissions: { push: true } }), { status: 200, headers: { 'content-type': 'application/json' } }),
  });
  const snapshot = await adapter.probe({ station: { stationId: 'STATION-GITHUB', ownerSystem: 'GITHUB' }, rail: { railId: 'RAIL-GITHUB' } });
  assert.equal(snapshot.scope.includes('CREATE_BRANCH'), true);
  assert.deepEqual(snapshot.capabilities.CREATE_BRANCH, { status: 'READY', reason: 'WRITE_PERMISSION_CONFIRMED' });
});
