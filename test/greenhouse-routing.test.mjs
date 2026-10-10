import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveCoordinationRoute, RoutingDenied,
  GREENHOUSE_STATION, FACTORY_STATION,
} from '../src/greenhouse-routing.mjs';

const base = {
  actor: 'GO', workId: 'WORK-1', checkpointId: 'WORK-1:CP-1',
  operation: 'execute', targetStation: FACTORY_STATION,
  authorization: {
    verified: true, actor: 'GO', workId: 'WORK-1',
    checkpointId: 'WORK-1:CP-1', operations: ['execute'],
  },
  greenhouse: {
    registered: true, authenticated: true,
    healthy: true, supportsHandoff: true,
  },
};
test('Factory request routes through Greenhouse', () => {
  const route = resolveCoordinationRoute(base);
  assert.equal(route.stationId, GREENHOUSE_STATION);
  assert.equal(route.payload.targetStation, FACTORY_STATION);
  assert.equal(route.payload.workId, base.workId);
  assert.equal(route.payload.checkpointId, base.checkpointId);
});
test('rejects unavailable Greenhouse instead of falling back to Factory', () => {
  assert.throws(
    () => resolveCoordinationRoute({...base, greenhouse: {...base.greenhouse, healthy: false}}),
    /GREENHOUSE_NOT_READY/,
  );
});
test('rejects mismatched Work grant', () => {
  assert.throws(
    () => resolveCoordinationRoute({...base, authorization: {...base.authorization, workId: 'OTHER'}}),
    /AUTHORIZATION_NOT_VERIFIED/,
  );
});
test('rejects unauthorized operation', () => {
  assert.throws(
    () => resolveCoordinationRoute({...base, operation: 'cancel'}),
    /AUTHORIZATION_NOT_VERIFIED/,
  );
});
test('rejects recursive route', () => {
  assert.throws(
    () => resolveCoordinationRoute({...base, targetStation: GREENHOUSE_STATION}),
    /RECURSIVE_GREENHOUSE_DESTINATION/,
  );
});
test('rejects missing checkpoint', () => {
  assert.throws(
    () => resolveCoordinationRoute({...base, checkpointId: ''}),
    /MISSING_WORK_CONTEXT/,
  );
});
