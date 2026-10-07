import test from 'node:test';
import assert from 'node:assert/strict';
import {createCityRuntime,createMemoryStore,WORK_STATE} from '../src/city-runtime.mjs';
function factoryBranchRuntime(){return{
  profile:{branchId:'FACTORY_BRANCH',stationId:'FACTORY_STATION',destinationId:'FACTORY',preflight:'FACTORY_HEALTH',returnInspection:'DWARF_VERIFY'},
  async handoff({workId,checkpointId,payload}){return{accepted:true,verified:true,receiptId:'FACTORY-R1',evidenceRef:'factory://handoff/R1',workId,checkpointId,journeyId:payload.journeyId};},
  async readback({workId,checkpointId}){return{workId,checkpointId,verified:true,domainVerified:true,evidenceRef:'factory://readback/R1',result:{artifactRefs:['artifact://factory/result-1'],evidence:[{status:'PASS',sourceRef:'ci://factory/1'}]}};},
};}
test('Station Branch golden path: ONLINE -> IN -> work -> OUT -> PIXIE -> GO -> MIMIR -> COMPLETE',async()=>{
 let tick=0; const runtime=createCityRuntime({store:createMemoryStore(),clock:()=>`2026-10-07T11:${String(tick++).padStart(2,'0')}:00.000Z`,idFactory:(()=>{let n=0;return()=>`ID-${++n}`;})(),stationRuntimes:{FACTORY_STATION:factoryBranchRuntime()}});
 const created=await runtime.intake({workId:'WORK-GOLDEN',ownerSystem:'FACTORY',requestedBy:'GO',workPassActor:'GO'});
 assert.equal(created.online.status,'ONLINE'); assert.equal(created.online.activation,'NEW');
 const sent=await runtime.handoff({workId:created.workId,checkpointId:created.checkpointId,stationId:'FACTORY_STATION',operation:'BUILD',actor:'GO',payload:{inputRefs:['artifact://source-1']}});
 assert.equal(sent.journeys[0].status,'IN_TRANSIT'); assert.equal(sent.journeys[0].baggageIn.payloadRefs[0],'artifact://source-1'); assert.equal(sent.journeys[0].branchProfile.returnInspection,'DWARF_VERIFY');
 const review=await runtime.returnWork({workId:created.workId,checkpointId:created.checkpointId,actor:'GO'});
 assert.equal(review.state,WORK_STATE.RETURN_REVIEW); assert.equal(review.stationReturnReview.status,'GO_REVIEW_REQUIRED');
 assert.equal(review.stationReturnReview.counts.artifactRefs,1); assert.equal(review.stationReturnReview.counts.evidenceRefs,1); assert.equal(review.journeys[0].status,'RETURNED'); assert.ok(review.journeys[0].outAt);
 const stored=await runtime.returnWork({workId:created.workId,checkpointId:created.checkpointId,actor:'GO',stationReviewed:true,updates:[{kind:'ARTIFACT',valueRef:'artifact://factory/result-1'}]});
 assert.equal(stored.state,WORK_STATE.RETURNED); assert.equal(stored.returnReview.status,'ORGANIZED'); assert.equal(stored.return.organized.updates[0].valueRef,'artifact://factory/result-1'); assert.equal(stored.dataLifecycle.every(entry=>entry.managedBy==='PIXIE'),true);
 const completed=await runtime.completeWork({workId:created.workId,requestedBy:'GO'});
 assert.equal(completed.state,WORK_STATE.COMPLETED); assert.equal(completed.online.status,'OFFLINE'); assert.equal(completed.online.closure,'COMPLETE'); assert.equal(completed.workPass.status,'COMPLETED');
});
test('HERMES resume re-announces the same Work online and Journey ID is searchable for recovery',async()=>{
 const runtime=createCityRuntime({store:createMemoryStore(),clock:()=> '2026-10-07T12:00:00.000Z'});
 const created=await runtime.intake({workId:'WORK-RECOVER',checkpointId:'WORK-RECOVER:CP-01',ownerSystem:'FACTORY',requestedBy:'GO',workPassActor:'GO'});
 const sent=await runtime.handoff({workId:created.workId,checkpointId:created.checkpointId,stationId:'FACTORY_STATION',operation:'TEST',actor:'GO'});
 const resumed=await runtime.resumeWork({workId:created.workId,actor:'GO'});
 assert.equal(resumed.workId,created.workId); assert.equal(resumed.checkpointId,created.checkpointId); assert.equal(resumed.online.activation,'RESUME'); assert.equal(sent.journeys[0].journeyId,'WORK-RECOVER:JOURNEY:1');
});
