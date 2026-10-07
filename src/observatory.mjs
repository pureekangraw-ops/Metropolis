import { hash, json } from './shared-mcp.mjs';
const browserActions=['NAVIGATE','OPEN','SELECT','CLOSE','BACK','FORWARD','RELOAD','SCROLL','CLICK','FILL'];
const mapActions=['UPSERT_ZONE','UPSERT_GRID','UPSERT_PIN','NOTE','RECOMMEND','HIGHLIGHT','FOCUS','REMOVE','CLEAR'];
export const OBSERVATORY_AUTHORITIES=Object.freeze(['browser.observe',...browserActions.map(a=>'browser.'+a.toLowerCase()),'map.observe',...mapActions.map(a=>'map.'+a.toLowerCase())]);
const terminal=receipt=>Boolean(receipt&&receipt.status!=='PENDING');
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fail=reason=>{throw new Error(reason);};
const integer=v=>Number.isSafeInteger(v)&&v>=0;
const canonical=v=>JSON.stringify(v,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(k=>[k,item[k]])):item);
function safe(value){
  if(new TextEncoder().encode(JSON.stringify(value)).length>49152)fail('PAYLOAD_TOO_LARGE');
  function inspect(v,depth=0){if(depth>16)fail('PAYLOAD_TOO_DEEP');if(v&&typeof v==='object')for(const [k,item]of Object.entries(v)){if(/^(authorization|cookie|password|passcode|token|apiKey|clientSecret|secret)$/i.test(k))fail('SECRET_FIELD_DENIED');inspect(item,depth+1);}}
  inspect(value);return structuredClone(value);
}
function redactText(text){return String(text).replace(/https?:\/\/[^\s<>"']+/gi, raw=>{try{const u=new URL(raw);u.username='';u.password='';u.search='';u.hash='';return u.toString();}catch{return '[REDACTED_URL]';}}).replace(/\b(Bearer\s+)[\w.\-]+/gi,'$1[REDACTED]').replace(/\b(password|passcode|api[_ -]?key|access[_ -]?token|secret)\s*[:=]\s*[^\s,;]+/gi,'$1=[REDACTED]');}
function redact(value){if(typeof value==='string')return redactText(value);if(Array.isArray(value))return value.map(redact);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,redact(v)]));return value;}
export function createObservatory({env,storage,runtime,clock=()=>Date.now()}={}){
  const key=id=>'observatory:device:'+id;
  async function context(session){const w=await runtime.getWork(session.workId);if(!session.active||!w||w.ownerSystem!=='OBSERVATORY'||w.checkpointId!==session.checkpointId)fail('CONTEXT_REVOKED');return w;}
  async function save(session){await storage.put(key(session.deviceId),session);}
  async function load(id){const s=await storage.get(key(id));if(!s)fail('AUTH_REQUIRED');await context(s);return s;}
  async function grants(actor){const index=await storage.get('observatory:devices')||[];const result=[];for(const id of index){let s;try{s=await load(id);}catch{continue;}if(s.actor!==actor)continue;result.push({actor,action:'read',workId:s.workId});for(const operation of ['observe','command','readback'])result.push({actor,action:'handoff',workId:s.workId,stationId:'OBSERVATORY_STATION',operation});}return result;}
  const fresh=s=>{if(!s||clock()-s.capturedAtEpochMs>30000||s.capturedAtEpochMs>clock()+5000)fail('STALE_CAPTURE');return s;};
  async function operation({actor,workId,checkpointId,operation,payload}){
    const s=await load(payload.deviceId);if(s.actor!==actor||s.workId!==workId||s.checkpointId!==checkpointId)fail('CONTEXT_MISMATCH');
    const view=payload.view;if(!['browser','map'].includes(view))fail('VIEW_INVALID');const box=s[view];if(!s.authorities.includes(view+'.observe'))fail('AUTHORITY_DENIED');
    if(operation==='observe')return {snapshot:fresh(box.snapshot),businessOutcome:'UNKNOWN'};
    if(operation==='readback'){
    const entry=box.commands.find(c=>c.command.commandId===payload.commandId);if(!entry)fail('COMMAND_NOT_FOUND');const snapshot=box.snapshot;const receipt=entry.receipt;
      const verified=Boolean(terminal(receipt)&&['ACCEPTED','EXECUTED','APPLIED'].includes(receipt.status)&&receipt?.afterCaptureId&&snapshot?.captureId===receipt.afterCaptureId&&snapshot.epoch===entry.command.epoch&&snapshot.revision>=entry.command.revision&&snapshot.capturedAtEpochMs>=receipt.executedAtEpochMs&&clock()-snapshot.capturedAtEpochMs<=30000&&snapshot.capturedAtEpochMs<=clock()+5000);
      return {commandId:entry.command.commandId,receipt:receipt||null,snapshot:verified?snapshot:null,afterSnapshotVerified:verified,businessOutcome:'UNKNOWN',ownerExecutionVerified:false};
    }
    if(operation!=='command')fail('OPERATION_INVALID');const c=safe(payload.command);if(new TextEncoder().encode(JSON.stringify(c)).length>8192)fail('COMMAND_TOO_LARGE');
    if(typeof c.commandId!=='string'||!c.commandId||c.commandId.length>128)fail('COMMAND_ID_INVALID');
    const existing=box.commands.find(e=>e.command.commandId===c.commandId);if(existing){if(canonical(existing.command)!==canonical(c))fail('DUPLICATE_CHANGED');return {commandId:c.commandId,queued:true,businessOutcome:'UNKNOWN'};}
    const snap=fresh(box.snapshot);
    for(const field of ['deviceId','captureId','revision','epoch'])if(c[field]!==snap[field])fail('CAPTURE_MISMATCH');
    if(c.actor!==actor||c.workId!==workId||c.checkpointId!==checkpointId)fail('CONTEXT_MISMATCH');
    if(!integer(c.issuedAtEpochMs)||!integer(c.expiresAtEpochMs)||c.issuedAtEpochMs>clock()+5000||c.expiresAtEpochMs<=clock()||c.expiresAtEpochMs-c.issuedAtEpochMs>30000||c.expiresAtEpochMs<c.issuedAtEpochMs)fail('TTL_INVALID');
    const action=view==='browser'?c.action:c.command?.action;
    if(!(view==='browser'?browserActions:mapActions).includes(action)||c.authority!==view+'.'+action.toLowerCase()||!s.authorities.includes(c.authority))fail('AUTHORITY_DENIED');
    if(view==='browser'&&(c.tabId!==snap.tabId||!c.parameters||typeof c.parameters!=='object'||Array.isArray(c.parameters)||Object.values(c.parameters).some(v=>typeof v!=='string')))fail('COMMAND_INVALID');
    if(view==='map'&&(snap.foreground!==true||snap.interactive!==true))fail('NOT_INTERACTIVE');
    if(view==='map'&&(c.command.commandId!==c.commandId||c.command.expectedRevision!==snap.revision))fail('COMMAND_INVALID');
    const allowed=['commandId','actor','workId','checkpointId','deviceId','captureId','revision','epoch','issuedAtEpochMs','expiresAtEpochMs','authority',...(view==='browser'?['tabId','action','parameters']:['command'])];if(Object.keys(c).some(k=>!allowed.includes(k)))fail('COMMAND_INVALID');
    if(box.commands.length>=100){const old=box.commands.findIndex(e=>terminal(e.receipt)||e.command.expiresAtEpochMs<=clock());if(old<0)fail('QUEUE_FULL');box.commands.splice(old,1);}
    box.commands.push({command:c,receipt:null});await save(s);return {commandId:c.commandId,queued:true,businessOutcome:'UNKNOWN',ownerExecutionVerified:false};
  }
  async function fetch(request){try{
    const url=new URL(request.url);if(url.origin!==env.MCP_PUBLIC_ORIGIN)return json({reason:'ORIGIN_MISMATCH'},403);
    const body=async()=>{if(!request.headers.get('content-type')?.startsWith('application/json'))fail('CONTENT_TYPE_REQUIRED');const raw=await request.text();if(new TextEncoder().encode(raw).length>65536)fail('PAYLOAD_TOO_LARGE');return JSON.parse(raw);};
    if(url.pathname==='/observatory/pair'){
      if(request.method!=='POST')return json({reason:'METHOD_NOT_ALLOWED'},405);const b=await body();const now=clock();const attemptKey='observatory:pair-attempts';let attempts=(await storage.get(attemptKey)||[]).filter(t=>now-t<900000);if(attempts.length>=5)return json({reason:'PAIR_RATE_LIMITED'},429);
      if(typeof b.passcode!=='string'||await hash(b.passcode)!==await hash(env.MCP_OWNER_PASSCODE)){await storage.put(attemptKey,[...attempts,now]);return json({reason:'AUTH_REQUIRED'},401);}
      if(!UUID.test(b.deviceId)||!['GO','LIGHT'].includes(b.actor)||!Array.isArray(b.authorities)||!b.authorities.length||new Set(b.authorities).size!==b.authorities.length||b.authorities.some(a=>!OBSERVATORY_AUTHORITIES.includes(a)))fail('PAIR_INVALID');
      const index=await storage.get('observatory:devices')||[];if(!index.includes(b.deviceId)&&index.length>=100)fail('DEVICE_LIMIT');
      let prior=await storage.get(key(b.deviceId));let work=prior?await runtime.getWork(prior.workId):null;
      if(!work||work.ownerSystem!=='OBSERVATORY'||work.checkpointId!==prior.checkpointId)work=await runtime.intake({ownerSystem:'OBSERVATORY',requestedBy:'BIG',inputRefs:['observatory:device:'+b.deviceId]});
      const token=Array.from(crypto.getRandomValues(new Uint8Array(32)),b=>b.toString(16).padStart(2,'0')).join('');
      const s={deviceId:b.deviceId,actor:b.actor,authorities:[...b.authorities],workId:work.workId,checkpointId:work.checkpointId,active:true,tokenHash:await hash(token),pairedAtEpochMs:now,browser:{snapshot:null,commands:[]},map:{snapshot:null,commands:[]}};
      if(!index.includes(b.deviceId))await storage.put('observatory:devices',[...index,b.deviceId]);await save(s);
      const config=view=>{const base=env.MCP_PUBLIC_ORIGIN+'/observatory/device/'+b.deviceId+(view==='map'?'/map':'');return {publishSnapshots:base+'/snapshots',pollCommands:base+'/commands',publishReceipts:base+'/receipts',stopSharing:env.MCP_PUBLIC_ORIGIN+'/observatory/device/'+b.deviceId+'/stop',disconnect:env.MCP_PUBLIC_ORIGIN+'/observatory/device/'+b.deviceId+'/disconnect',deviceId:s.deviceId,actor:s.actor,workId:s.workId,checkpointId:s.checkpointId,authorities:s.authorities.filter(a=>a.startsWith(view+'.'))};};
      return json({token,browser:config('browser'),map:config('map')});
    }
    const match=url.pathname.match(/^\/observatory\/device\/([^/]+)\/(map\/)?(snapshots|commands|receipts|disconnect|stop)$/);if(!match)return json({reason:'ROUTE_NOT_FOUND'},404);
    const [,id,map,route]=match;let s;try{s=await load(id);const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];if(!token||await hash(token)!==s.tokenHash)fail('AUTH_REQUIRED');}catch{return json({reason:'AUTH_REQUIRED'},401);}
    const view=map?'map':'browser',box=s[view];if(route==='commands') {if(request.method!=='GET')return json({reason:'METHOD_NOT_ALLOWED'},405);return json({commands:box.commands.filter(e=>!terminal(e.receipt)&&e.command.expiresAtEpochMs>clock()).map(e=>e.command)});}
    if(request.method!=='POST')return json({reason:'METHOD_NOT_ALLOWED'},405);
    if(route==='stop'){const b=await body();if(!['browser','map'].includes(b.view)||!integer(b.epoch))fail('SNAPSHOT_INVALID');const box=s[b.view];box.minEpoch=Math.max(box.minEpoch||0,b.epoch,(box.snapshot?.epoch??-1)+1);box.snapshot=null;box.commands=[];await save(s);return json({stopped:true,view:b.view,epoch:box.minEpoch});}
    if(route==='disconnect'){s.active=false;s.tokenHash=null;s.browser={snapshot:null,commands:[]};s.map={snapshot:null,commands:[]};await save(s);return json({disconnected:true});}
    let b=redact(safe(await body()));
    if(route==='snapshots'){
      if(!s.authorities.includes(view+'.observe'))fail('AUTHORITY_DENIED');if(b.deviceId!==id||!b.captureId||!['revision','epoch','sequence','capturedAtEpochMs'].every(k=>integer(b[k])))fail('SNAPSHOT_INVALID');fresh(b);if(b.epoch<(box.minEpoch||0))fail('SNAPSHOT_REPLAY');
      if(b.schema!==(view==='browser'?'observer.snapshot.v1':'observatory.map.snapshot.v1'))fail('SCHEMA_INVALID');
      if(view==='map'&&Object.keys(b).some(k=>!['schema','deviceId','captureId','revision','epoch','sequence','capturedAtEpochMs','workId','checkpointId','state','foreground','interactive'].includes(k)))fail('SNAPSHOT_INVALID');
      if(view==='map'&&(b.workId!==s.workId||b.checkpointId!==s.checkpointId||!b.state||!['zones','grids','pins','notes'].every(k=>Array.isArray(b.state[k]))))fail('SNAPSHOT_INVALID');
      if(view==='browser'){
        if(typeof b.text!=='string'||new TextEncoder().encode(b.text).length>32768||!b.tabId||!Array.isArray(b.targets)||b.targets.length>300)fail('SNAPSHOT_INVALID');
        try{const u=new URL(b.url);u.username='';u.password='';u.search='';u.hash='';b.url=u.toString();}catch{b.url='';}
        const allowed=['deviceId','tabId','captureId','revision','sequence','epoch','capturedAtEpochMs','appVersion','schema','url','title','text','targets','truncated'];if(Object.keys(b).some(k=>!allowed.includes(k)))fail('SNAPSHOT_INVALID');
      }
      const previous=box.snapshot;if(previous){if(b.captureId===previous.captureId){if(canonical(b)!==canonical(previous))fail('DUPLICATE_CHANGED');return json({id:b.captureId,sequence:b.sequence,acceptedAtEpochMs:clock()});}if(b.epoch<previous.epoch||(b.epoch===previous.epoch&&b.sequence<=previous.sequence))fail('SNAPSHOT_REPLAY');}
      box.snapshot=b;box.commands=box.commands.filter(e=>e.receipt||e.command.epoch===b.epoch);await save(s);return json({id:b.captureId,sequence:b.sequence,acceptedAtEpochMs:clock()});
    }
    if(typeof b.reason!=='string'||(b.readback!==null&&typeof b.readback!=='string')||(b.beforeCaptureId!==null&&typeof b.beforeCaptureId!=='string')||(b.afterCaptureId!==null&&typeof b.afterCaptureId!=='string'))fail('RECEIPT_INVALID');
    const entry=box.commands.find(e=>e.command.commandId===b.commandId);if(!entry)fail('COMMAND_NOT_FOUND');
    if(entry.receipt){if(canonical(entry.receipt)===canonical(b))return json({id:b.commandId,sequence:0,acceptedAtEpochMs:clock()});if(terminal(entry.receipt)||b.status==='PENDING'||entry.receipt.beforeCaptureId!==b.beforeCaptureId)fail('DUPLICATE_CHANGED');}
    if(!(view==='map'?['APPLIED','PENDING','REJECTED','CONFLICT','FAILED','UNKNOWN']:['ACCEPTED','REJECTED','EXECUTED','UNKNOWN']).includes(b.status)||b.businessOutcome!=='UNKNOWN'||!integer(b.executedAtEpochMs)||b.executedAtEpochMs>clock()+5000||b.executedAtEpochMs<entry.command.issuedAtEpochMs||(['ACCEPTED','EXECUTED','APPLIED'].includes(b.status)&&(b.beforeCaptureId!==entry.command.captureId||b.executedAtEpochMs>entry.command.expiresAtEpochMs))||!['commandId','status','reason','beforeCaptureId','afterCaptureId','executedAtEpochMs','readback','businessOutcome'].every(k=>Object.hasOwn(b,k))||Object.keys(b).some(k=>!['commandId','status','reason','beforeCaptureId','afterCaptureId','executedAtEpochMs','readback','businessOutcome'].includes(k)))fail('RECEIPT_INVALID');
    entry.receipt=b;await save(s);return json({id:b.commandId,sequence:0,acceptedAtEpochMs:clock()});
  }catch(error){return json({reason:['AUTHORITY_DENIED','PAYLOAD_TOO_LARGE','DUPLICATE_CHANGED','SNAPSHOT_REPLAY','SNAPSHOT_INVALID','SCHEMA_INVALID','COMMAND_NOT_FOUND','RECEIPT_INVALID','SECRET_FIELD_DENIED','CONTENT_TYPE_REQUIRED','STALE_CAPTURE','PAIR_INVALID','DEVICE_LIMIT'].includes(error.message)?error.message:'INVALID_REQUEST'},400);}}
  return {fetch,grants,operation};
}
