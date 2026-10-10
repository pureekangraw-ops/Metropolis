import test from 'node:test';
import assert from 'node:assert/strict';
import {createGreenhouseFactoryTransit} from '../src/greenhouse-factory-transit.mjs';
const workId='WORK-123',checkpointId='WORK-123:CP-01';
function scenario(opts={}){
 const seen=[],factoryCalls=[];
 const service={async fetch(request){
  const payload=JSON.parse(await request.text());
  seen.push({url:new URL(request.url).pathname,payload,signature:request.headers.get('x-metropolis-greenhouse-signature')});
  if(seen.length===1){
   if(opts.duplicate)return Response.json({workId,checkpointId,attemptId:payload.attemptId,status:'QUEUED',duplicate:true},{status:202});
   if(opts.down)return Response.json({reason:'UNAVAILABLE'},{status:503});
   return Response.json({workId,checkpointId,attemptId:payload.attemptId,status:'QUEUED',duplicate:false},{status:202});
  }
  return Response.json({workId,checkpointId,attemptId:payload.attemptId,status:'READBACK_VERIFIED',
   receiptRef:payload.receiptRef,evidenceRef:payload.evidenceRef});
 }};
 const factory={async handoff(input){factoryCalls.push(input);return {verified:true,receiptId:'receipt-1',evidenceRef:'evidence-1'};},
  async readback(){return {verified:true};}};
 const adapter=createGreenhouseFactoryTransit({factory,service,sharedSecret:'signed-rail',
  onlyWorkId:workId,clock:()=>Date.parse('2026-10-10T05:00:00Z')});
 const payload={journeyId:'WORK-123:JOURNEY:1',actingActor:'GO',
  workPassRef:'work-pass://pass1',workPass:{passId:'pass1',workId,checkpointId,status:'ACTIVE',
    permissions:{actions:['handoff'],handoff:[{stationId:'FACTORY_STATION'}]}}};
 const input={workId,checkpointId,stationId:'FACTORY_STATION',operation:'FACTORY_HANDOFF',payload};
 return {adapter,input,seen,factoryCalls};
}
test('City-approved work crosses Greenhouse and Factory and returns receipt',async()=>{
 const x=scenario();const r=await x.adapter.handoff(x.input);
 assert.equal(x.seen.length,2);assert.equal(x.factoryCalls.length,1);
 assert.equal(x.seen[0].url,'/station/intake');
 assert.equal(x.seen[1].url,'/station/factory-readback');
 assert.equal(x.seen[0].payload.attemptId,x.seen[1].payload.attemptId);
 assert.equal(x.seen[0].payload.workId,workId);
 assert.equal(x.seen[1].payload.receiptRef,'receipt-1');
 assert.equal(r.greenhouse.verified,true);
 assert.match(x.seen[0].signature,/^[a-f0-9]{64}$/);
});
test('wrong Work Pass cannot dispatch',async()=>{
 const x=scenario();
 await assert.rejects(()=>x.adapter.handoff({...x.input,payload:{...x.input.payload,
  workPass:{...x.input.payload.workPass,checkpointId:'WORK-123:CP-02'}}}),/GREENHOUSE_WORK_SCOPE_INVALID/);
 assert.equal(x.seen.length,0);assert.equal(x.factoryCalls.length,0);
});
test('unknown previous delivery cannot dispatch again',async()=>{
 const x=scenario({duplicate:true});
 await assert.rejects(()=>x.adapter.handoff(x.input),/GREENHOUSE_EXISTING_ATTEMPT_VERIFY_FIRST/);
 assert.equal(x.factoryCalls.length,0);
});
test('missing intake acknowledgment stops before Factory',async()=>{
 const x=scenario({down:true});
 await assert.rejects(()=>x.adapter.handoff(x.input),/GREENHOUSE_INTAKE_UNVERIFIED/);
 assert.equal(x.factoryCalls.length,0);
});
test('non-pilot Work remains on existing trusted rail',async()=>{
 const x=scenario();
 await x.adapter.handoff({...x.input,workId:'WORK-unrelated'});
 assert.equal(x.seen.length,0);assert.equal(x.factoryCalls.length,1);
});
