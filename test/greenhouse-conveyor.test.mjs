import test from 'node:test';
import assert from 'node:assert/strict';
import {createGreenhouseConveyor,railRequest} from '../src/greenhouse-conveyor.mjs';
import {createWorkPass} from '../src/work-pass.mjs';
function fixture(actor='LIGHT'){
  const rows=new Map(),workId='WORK-conveyor',checkpointId=workId+':CP-01';
  const pass=createWorkPass({workId,checkpointId,actor});
  rows.set('work:'+workId,{workId,checkpointId,state:'HANDED_OFF',workPass:pass,workPassRef:'work-pass://'+pass.passId});
  const storage={get:async k=>structuredClone(rows.get(k)),put:async(k,v)=>rows.set(k,structuredClone(v))};
  let envelope,calls=0;
  const env={METROPOLIS_GREENHOUSE_RAIL_SECRET:'test-only-rail',MCP_WORK_GRANTS:'[]',GREENHOUSE_TRANSPORT:{async fetch(request){envelope=await request.json();return new Response(JSON.stringify({...envelope,status:'QUEUED'}),{status:202});}}};
  const conveyor=createGreenhouseConveyor({env,storage,runtime:{getWork:id=>storage.get('work:'+id)},
    factory:{handoff:async input=>{calls++;assert.equal(input.payload.requestedResult,'Original cargo');return {verified:true,receiptId:'factory-1',evidenceRef:'factory://proof'};},readback:async()=>({verified:true})},observatory:{}});
  const input={workId,checkpointId,actor,stationId:'FACTORY_STATION',operation:'CODE',payload:{ownerDomain:'CODE',scope:['EXECUTE:CODE'],intent:'Original cargo',journeyId:'journey-1',requestedResult:'Original cargo',workPassRef:'work-pass://'+pass.passId,workPass:pass}};
  return {rows,storage,conveyor,input,get envelope(){return envelope;},get calls(){return calls;},
    invoke:path=>railRequest({fetch:r=>conveyor.fetch(r)},env.METROPOLIS_GREENHOUSE_RAIL_SECRET,path,envelope)};
}
test('City-approved LIGHT job preserves cargo; queue duplicate reuses owner receipt',async()=>{
  const x=fixture();const queued=await x.conveyor.factory.handoff(x.input);
  assert.equal(x.calls,0);assert.equal(queued.status,'QUEUED');
  const w=x.rows.get('work:'+x.input.workId);w.handoff={external:queued};
  assert.equal((await (await x.invoke('/station/dispatch')).json()).verified,true);
  assert.equal((await (await x.invoke('/station/dispatch')).json()).receiptRef,'factory-1');
  assert.equal((await (await x.invoke('/station/readback')).json()).verified,true);
  assert.equal(x.calls,1);assert.equal(x.rows.get('work:'+x.input.workId).state,'HANDED_OFF');
});
test('revoked Work Pass prevents destination execution after queue acceptance',async()=>{
  const x=fixture('GO');const queued=await x.conveyor.factory.handoff(x.input);
  const w=x.rows.get('work:'+x.input.workId);w.handoff={external:queued};w.workPass={...w.workPass,status:'CANCELLED'};
  const result=await (await x.invoke('/station/dispatch')).json();
  assert.equal(result.notSent,true);assert.equal(result.reason,'WORK_AUTHORIZATION_REVOKED');assert.equal(x.calls,0);
});
test('signed rail cannot retarget an approved Job to another Work',async()=>{
  const x=fixture();await x.conveyor.factory.handoff(x.input);
  const reply=await railRequest({fetch:r=>x.conveyor.fetch(r)},'test-only-rail','/station/dispatch',{...x.envelope,workId:'WORK-other'});
  assert.equal(reply.status,403);assert.equal(x.calls,0);
  const forged=await x.conveyor.fetch(new Request('https://city.internal/station/dispatch',{method:'POST',body:JSON.stringify(x.envelope)}));
  assert.equal(forged.status,401);
});


test('legacy Factory preflight failure proves no send and recovers the exact original job',async()=>{
 const x=fixture();const queued=await x.conveyor.factory.handoff(x.input);
 x.rows.get('work:'+x.input.workId).handoff={external:queued};
 const key='greenhouse:job:'+queued.jobId,job=x.rows.get(key);
 x.rows.set(key,{...job,status:'OUTCOME_UNKNOWN',reason:'FACTORY_PREFLIGHT_UNAVAILABLE'});
 const proof=await (await x.invoke('/station/readback')).json();
 assert.equal(proof.notSent,true);assert.equal(x.calls,0);
 assert.equal((await (await x.invoke('/station/dispatch')).json()).verified,true);
 assert.equal(x.calls,1);
 const status=await x.conveyor.jobStatus(x.rows.get('work:'+x.input.workId));
 assert.equal(status[0].jobId,queued.jobId);assert.equal(status[0].deliveryVerified,true);
});
test('missing Factory domain or scope is rejected before the queue receives a job',async()=>{
 const x=fixture();
 await assert.rejects(()=>x.conveyor.factory.handoff({...x.input,payload:{...x.input.payload,ownerDomain:undefined}}),/FACTORY_CARGO_INVALID/);
 assert.equal(x.envelope,undefined);assert.equal(x.calls,0);
});
