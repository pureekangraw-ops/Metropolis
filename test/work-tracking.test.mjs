import test from 'node:test';
import assert from 'node:assert/strict';
import { projectWorkTracking } from '../src/work-tracking.mjs';

const base = {workId:'WORK-1',checkpointId:'CP-1',state:'HANDED_OFF',online:{status:'ONLINE'}};
test('accepted transport does not pretend worker execution', () => {
 const result=projectWorkTracking({...base,handoff:{stationId:'FACTORY_STATION',external:{verified:true,boundaryVerified:true,jobId:'ATT-1',status:'READBACK_VERIFIED'}},journeys:[{journeyId:'J-1',stationId:'FACTORY_STATION',status:'IN_TRANSIT'}]}, {observedAt:'2026-10-12T00:00:00Z'});
 assert.equal(result.transport,'VERIFIED'); assert.equal(result.execution,'UNKNOWN'); assert.equal(result.signal,'ONLINE'); assert.equal(result.jobId,'ATT-1');
 assert.equal(result.freshness,'SNAPSHOT');
});
test('new work is not dispatched and never fabricates a job', () => {
 const result=projectWorkTracking({workId:'WORK-2',checkpointId:'CP-1',state:'RECEIVED'});
 assert.equal(result.execution,'NOT_DISPATCHED'); assert.equal(result.jobId,null);
});
test('terminal work is closed; missing identity rejected', () => {
 assert.equal(projectWorkTracking({...base,state:'COMPLETED'}).execution,'CLOSED');
 assert.throws(()=>projectWorkTracking({}),/WORK_TRACKING_IDENTITY_REQUIRED/);
});

test('only a verified worker signal can show RUNNING', () => {
 const handoff={external:{verified:true,boundaryVerified:true}};
 const unverified=projectWorkTracking({...base,handoff,reports:[{result:{execution:'RUNNING',verified:false}}]});
 const verified=projectWorkTracking({...base,handoff,reports:[{result:{execution:'RUNNING',verified:true}}]});
 assert.equal(unverified.execution,'UNKNOWN');
 assert.equal(verified.execution,'RUNNING');
});
