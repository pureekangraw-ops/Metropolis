// City-authorized Factory handoff passes through Greenhouse without changing Hall ownership.
const text=x=>typeof x==='string'?x.trim():'';
const hex=b=>[...b].map(x=>x.toString(16).padStart(2,'0')).join('');
async function attemptFor(workId,checkpointId,journeyId){
 const encoded=new TextEncoder().encode([workId,checkpointId,journeyId].join('|'));
 return 'ATT-'+hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded))).slice(0,40);
}
async function signedRequest(service,secret,path,payload,clock){
 const body=JSON.stringify(payload),timestamp=String(clock());
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const signature=hex(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(timestamp+'.'+body))));
 const result=await service.fetch(new Request('https://greenhouse.internal'+path,{method:'POST',
  headers:{'content-type':'application/json',
   'x-metropolis-greenhouse-timestamp':timestamp,'x-metropolis-greenhouse-signature':signature},body}));
 let data=null;try{data=await result.json();}catch{}
 return {status:result.status,ok:result.ok,data};
}
export function createGreenhouseFactoryTransit({factory,service,sharedSecret,onlyWorkId,clock=()=>Date.now()}={}){
 if(!factory||typeof factory.handoff!=='function'||typeof factory.readback!=='function')throw new TypeError('FACTORY_REQUIRED');
 return Object.freeze({
  async handoff(input={}){
   if(!text(onlyWorkId)||input.workId!==onlyWorkId)return factory.handoff(input);
   if(typeof service?.fetch!=='function'||!text(sharedSecret))throw new Error('GREENHOUSE_TRANSIT_NOT_CONFIGURED');
   const p=input.payload||{},pass=p.workPass;
   if(!text(input.checkpointId)||!text(p.journeyId)||!text(p.actingActor)||
     pass?.status!=='ACTIVE'||pass?.workId!==input.workId||pass?.checkpointId!==input.checkpointId||
     !text(p.workPassRef)||p.workPassRef!=='work-pass://'+pass.passId||
     !pass?.permissions?.actions?.includes('handoff')||
     !pass?.permissions?.handoff?.some(x=>x.stationId==='FACTORY_STATION'))
     throw new Error('GREENHOUSE_WORK_SCOPE_INVALID');
   const attemptId=await attemptFor(input.workId,input.checkpointId,p.journeyId);
   const intake=await signedRequest(service,sharedSecret,'/station/intake',{
     attemptId,workId:input.workId,checkpointId:input.checkpointId,stationId:'FACTORY_STATION',
     operation:input.operation,workPassRef:p.workPassRef,actor:p.actingActor},clock);
   if(!intake.ok||intake.data?.workId!==input.workId||
      intake.data?.checkpointId!==input.checkpointId||
      intake.data?.attemptId!==attemptId||
      intake.data?.duplicate===true||
      !['QUEUED','WAITING_QUEUE','PENDING_QUEUE'].includes(intake.data?.status))
     throw new Error(intake.data?.duplicate===true?'GREENHOUSE_EXISTING_ATTEMPT_VERIFY_FIRST':'GREENHOUSE_INTAKE_UNVERIFIED');
   // Factory preflight, HMAC transport and Work Pass validation remain authoritative.
   const factoryResult=await factory.handoff(input);
   if(factoryResult?.verified!==true||!text(factoryResult.receiptId)||!text(factoryResult.evidenceRef))
     throw new Error('FACTORY_BOUNDARY_UNVERIFIED');
   let audit={verified:false,attemptId,reason:'GREENHOUSE_READBACK_NOT_VERIFIED'};
   try{
     const reply=await signedRequest(service,sharedSecret,'/station/factory-readback',{
       attemptId,workId:input.workId,checkpointId:input.checkpointId,
       receiptRef:factoryResult.receiptId,evidenceRef:factoryResult.evidenceRef,
       verified:true,domainCompleted:false},clock);
     if(reply.ok&&reply.data?.status==='READBACK_VERIFIED'&&reply.data?.workId===input.workId&&
        reply.data?.checkpointId===input.checkpointId&&reply.data?.receiptRef===factoryResult.receiptId&&
        reply.data?.evidenceRef===factoryResult.evidenceRef)
        audit={verified:true,attemptId,receiptRef:factoryResult.receiptId};
   }catch{audit={verified:false,attemptId,reason:'GREENHOUSE_READBACK_UNREACHABLE'};}
   return Object.freeze({...factoryResult,greenhouse:audit});
  },
  readback(input){return factory.readback(input);},
 });
}
