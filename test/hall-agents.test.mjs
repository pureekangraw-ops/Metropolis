import test from 'node:test';
import assert from 'node:assert/strict';
import { createCityRuntime } from '../src/city-runtime.mjs';
import { createContextPack, projectForConsumer } from '../src/agents/mimir/legacy-logic-v1.mjs';

const record = fields => ({recordId:'R',title:'public title',summary:'secret summary',lifecycleStatus:'current',sourceRefs:['source://secret'],evidenceRefs:['evidence://secret'],routeHint:'private-route',routeEvidenceRefs:['route://secret'],accessScope:{visibility:'internal',allowedConsumers:['HERMES'],fields}});
const pack = records => createContextPack({contextPackId:'PACK',consumer:'HERMES',generatedAt:'2026-10-06T00:00:00Z',records});

test('HERMES rejects malformed input references without recording intake', async()=>{
 for(const inputRefs of ['abc',[{}],[' '],null]) {
  const runtime=createCityRuntime();
  await assert.rejects(()=>runtime.intake({workId:'W',checkpointId:'CP',ownerSystem:'FACTORY',inputRefs}),/inputRefs/);
  assert.equal(await runtime.getWork('W'),undefined);
 }
});
test('HERMES rejects non-object handoff payload without replacing state',async()=>{
 for(const payload of [[],null,'command']) {
  const runtime=createCityRuntime();await runtime.intake({workId:'W',checkpointId:'CP',ownerSystem:'FACTORY'});
  await assert.rejects(()=>runtime.handoff({workId:'W',checkpointId:'CP',stationId:'S',railId:'R',operation:'EXECUTE',payload}),/payload/);
  assert.equal((await runtime.getWork('W')).state,'RECEIVED');
 }
});
test('MIMIR rejects malformed return evidence before changing state',async()=>{
 const runtime=createCityRuntime();await runtime.intake({workId:'W',checkpointId:'CP',ownerSystem:'FACTORY'});
 await assert.rejects(()=>runtime.returnWork({workId:'W',checkpointId:'CP',evidenceRefs:'secret'}),/evidenceRefs/);
 assert.equal((await runtime.getWork('W')).state,'RECEIVED');
});
test('MIMIR context pack cannot expose excluded summary or references',()=>{
 const result=pack([record(['title'])]);
 assert.deepEqual(result.currentFacts,['public title']);assert.deepEqual(result.evidenceRefs,[]);assert.deepEqual(result.basedOnRecordIds,[]);
});
test('MIMIR context pack enforces the effective field intersection',()=>{
 const result=pack([record(['summary']),{...record(['title']),recordId:'R2'}]);
 assert.deepEqual(result.effectiveScope.fields,[]);assert.deepEqual(result.currentFacts,[]);assert.deepEqual(result.evidenceRefs,[]);
});
test('MIMIR empty field grant releases no content',()=>{
 const result=pack([record([])]);assert.deepEqual(result.currentFacts,[]);assert.deepEqual(result.basedOnRecordIds,[]);
});
test('MIMIR projection respects field grants and denied consumers',()=>{
 const projected=projectForConsumer(record(['recordId']), 'HERMES');
 assert.equal(projected.recordId,'R');assert.deepEqual(projected.sourceRefs,[]);assert.deepEqual(projected.evidenceRefs,[]);assert.equal(projected.routeHint,null);assert.deepEqual(projected.routeEvidenceRefs,[]);
 const denied=projectForConsumer(record(null),'SPECTRUM');assert.equal(denied.recordId,null);
});
test('MIMIR unrestricted grant keeps evidence and readable summary',()=>{
 const result=pack([record(null)]);assert.deepEqual(result.currentFacts,['secret summary']);assert.deepEqual(result.evidenceRefs,['evidence://secret']);
});
