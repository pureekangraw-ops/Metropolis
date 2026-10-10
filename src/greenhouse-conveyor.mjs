// Greenhouse schedules delivery; City Hall retains authorization and owner receipts.
import { inspectWorkPass, workPassAllowsHandoff } from './work-pass.mjs';
const encoder = new TextEncoder();
const hex = bytes => [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers:{'content-type':'application/json','cache-control':'no-store'}});
export async function railRequest(service, secret, path, payload = null) {
  if (!service?.fetch || !secret) throw new Error('GREENHOUSE_NOT_CONNECTED');
  const body = payload === null ? '' : JSON.stringify(payload), timestamp = String(Date.now());
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  const signature = hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp+'.'+body))));
  return service.fetch(new Request('https://greenhouse.internal'+path, {method:payload === null ? 'GET' : 'POST', headers:{
    'content-type':'application/json','x-metropolis-greenhouse-timestamp':timestamp,'x-metropolis-greenhouse-signature':signature,
  }, ...(payload === null ? {} : {body})}));
}
export async function verifyRail(request, secret, body) {
  const timestamp=request.headers.get('x-metropolis-greenhouse-timestamp'), signature=request.headers.get('x-metropolis-greenhouse-signature');
  if (!secret || !/^\d{13}$/.test(timestamp||'') || Math.abs(Date.now()-Number(timestamp))>300000 || !/^[a-f0-9]{64}$/i.test(signature||'')) return false;
  const key=await crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  return crypto.subtle.verify('HMAC',key,new Uint8Array(signature.match(/../g).map(x=>parseInt(x,16))),encoder.encode(timestamp+'.'+body));
}
export function createGreenhouseConveyor({env, storage, runtime, factory, observatory, clock=()=>new Date().toISOString()}) {
  const key = id => 'greenhouse:job:'+id;
  async function enqueue(input) {
    const seed=[input.workId,input.checkpointId,input.stationId,input.operation,input.payload.journeyId||crypto.randomUUID()].join('|');
    const attemptId='ATT-'+hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(seed)))).slice(0,40);
    // Save the City-approved request before enqueue. Never trust a queue's authority claims.
    const job={...structuredClone(input),attemptId,status:'PENDING_QUEUE',createdAt:clock()};
    await storage.put(key(attemptId),job);
    let response;
    try { response=await railRequest(env.GREENHOUSE_TRANSPORT,env.METROPOLIS_GREENHOUSE_RAIL_SECRET,'/station/intake',{
      workId:input.workId,checkpointId:input.checkpointId,stationId:input.stationId,operation:input.operation,
      workPassRef:input.payload.workPassRef,actor:input.actor,attemptId,payload:input.payload,
    }); } catch { throw new Error('GREENHOUSE_ENQUEUE_UNREACHABLE'); }
    const reply=await response.json();
    if(!response.ok || reply.attemptId!==attemptId || reply.workId!==input.workId || reply.checkpointId!==input.checkpointId)
      throw new Error('GREENHOUSE_ENQUEUE_UNVERIFIED');
    await storage.put(key(attemptId),{...job,status:reply.status});
    return {accepted:true,jobId:attemptId,attemptId,status:reply.status,workId:input.workId,
      checkpointId:input.checkpointId,stationId:input.stationId,operation:input.operation,actor:input.actor,
      verified:false,execution:'QUEUED',workCompletion:'NOT_ASSERTED'};
  }
  async function dispatch(attemptId) {
    const job=await storage.get(key(attemptId));
    if(!job)return {notSent:true,reason:'CITY_JOB_NOT_FOUND'};
    if(job.result)return job.result;
    if(job.status==='DISPATCHING'||job.status==='OUTCOME_UNKNOWN')return {accepted:false,reason:'DISPATCH_READBACK_REQUIRED'};
    const work=await runtime.getWork(job.workId);
    if(!work||work.checkpointId!==job.checkpointId||['CANCELLED','COMPLETED'].includes(work.state))
      return {notSent:true,reason:'WORK_NOT_ACTIVE'};
    const grants=JSON.parse(env.MCP_WORK_GRANTS||'[]').filter(g=>g.actor===job.actor&&g.workId===job.workId);
    const allowed=job.stationId==='FACTORY_STATION'
      ? (grants.length ? grants.some(g=>g.action==='handoff'&&[job.stationId,'*'].includes(g.stationId)&&[job.operation,'*'].includes(g.operation))
          : workPassAllowsHandoff(work.workPass,{workId:job.workId,checkpointId:job.checkpointId,actor:job.actor,workState:work.state,stationId:job.stationId}))
      : (grants.length ? grants.some(g=>g.action==='read')
          : inspectWorkPass(work.workPass,{workId:job.workId,checkpointId:job.checkpointId,actor:job.actor,workState:work.state}).actions.includes('read'));
    if(!allowed)return {notSent:true,reason:'WORK_AUTHORIZATION_REVOKED'};
    if(job.stationId==='FACTORY_STATION' && work.handoff?.external?.jobId!==attemptId)
      return {notSent:true,reason:'CITY_HANDOFF_NOT_COMMITTED'};
    await storage.put(key(attemptId),{...job,status:'DISPATCHING',dispatchedAt:clock()});
    try {
      let external;
      if(job.stationId==='FACTORY_STATION') external=await factory.handoff(job);
      else if(job.stationId==='OBSERVATORY_STATION') {
        const observed=await observatory.observe({actor:job.actor,workId:job.workId,checkpointId:job.checkpointId,view:job.payload.view});
        external={verified:observed.readbackVerified===true,receiptId:observed.receipt.receiptId,
          evidenceRef:'metropolis-station-receipt://'+observed.receipt.receiptId,stationResult:observed,domainVerified:true};
      } else throw new Error('STATION_UNAVAILABLE');
      if(external.verified!==true||!external.receiptId||!external.evidenceRef)throw new Error('DESTINATION_READBACK_UNVERIFIED');
      const result={accepted:true,verified:true,workId:job.workId,checkpointId:job.checkpointId,
        receiptRef:external.receiptId,evidenceRef:external.evidenceRef,domainCompleted:false};
      await storage.put(key(attemptId),{...job,status:'READBACK_VERIFIED',result,external,readbackAt:clock()});
      // The Work record remains in City Hall. Queue state never completes a Work.
      if(job.stationId==='FACTORY_STATION') await storage.put('work:'+job.workId,{...work,
        handoff:{...work.handoff,external:{...external,jobId:attemptId,attemptId,status:'READBACK_VERIFIED'}},updatedAt:clock()});
      else await storage.put('work:'+job.workId,{...work,stationJobs:[...(work.stationJobs||[]).filter(x=>x.jobId!==attemptId),
        {jobId:attemptId,stationId:job.stationId,status:'READBACK_VERIFIED',receiptId:external.receiptId,evidenceRef:external.evidenceRef,stationResult:external.stationResult}],updatedAt:clock()});
      return result;
    }catch(error){
      // Only errors that provably precede destination execution may be retried.
      const safe=new Set(['DEVICE_NOT_PAIRED','STALE_CAPTURE','READBACK_CONTEXT_MISMATCH','WORK_OWNER_MISMATCH','VIEW_INVALID']);
      const notSent=job.stationId==='OBSERVATORY_STATION'&&safe.has(error.message);
      await storage.put(key(attemptId),{...job,status:notSent?'WAITING_ROUTE':'OUTCOME_UNKNOWN',reason:error.message,dispatchedAt:clock()});
      return notSent?{notSent:true,reason:error.message}:{accepted:false,reason:'DISPATCH_READBACK_REQUIRED'};
    }
  }
  return {
    factory:{handoff:enqueue,readback:async input=> input.handoff?.external?.status==='READBACK_VERIFIED'
      ? factory.readback(input) : {verified:false,reason:'GREENHOUSE_JOB_PENDING',jobId:input.handoff?.external?.jobId}},
    async observe(input){
      const work=await runtime.getWork(input.workId);
      const queued=await enqueue({...input,stationId:'OBSERVATORY_STATION',operation:'observe',payload:{view:input.view,workPassRef:work.workPassRef}});
      await storage.put('work:'+work.workId,{...work,stationJobs:[...(work.stationJobs||[]),queued],updatedAt:clock()});
      return queued;
    },
    async fetch(request){
      if(request.method!=='POST')return json({reason:'METHOD_NOT_ALLOWED'},405);
      const body=await request.text();
      if(body.length>16384)return json({reason:'BODY_TOO_LARGE'},413);
      if(!await verifyRail(request,env.METROPOLIS_GREENHOUSE_RAIL_SECRET,body))return json({reason:'RAIL_SIGNATURE_INVALID'},401);
      let input;try{input=JSON.parse(body);}catch{return json({reason:'INVALID_ARGUMENT'},400);}
      const job=await storage.get(key(input.attemptId));
      if(!job||['workId','checkpointId','stationId','operation','actor'].some(k=>input[k]!==job[k])||input.workPassRef!==job.payload.workPassRef)
        return json({notSent:true,reason:'CITY_JOB_SCOPE_MISMATCH'},403);
      if(new URL(request.url).pathname==='/station/readback')return json(job.result||{accepted:false,status:job.status,reason:job.reason||'DESTINATION_READBACK_PENDING'});
      return json(await dispatch(input.attemptId));
    },
  };
}
