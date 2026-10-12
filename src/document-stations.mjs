// Credentials stay in Metro; Greenhouse receives approved operations and results.
export const DOCUMENT_OPERATIONS=Object.freeze({
 DRIVE_STATION:['list','search','read','read_content','create_text','update_text'],
 NOTION_STATION:['search','read','read_blocks','create_page','append_text'],
});
const fail=(code,notSent=false)=>{throw Object.assign(new Error(code),{notSent});};
const id=v=>{if(typeof v!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(v))fail('TOOL_ARGUMENT_INVALID',true);return v;};
const notionId=v=>{if(typeof v!=='string'||!/^([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(v))fail('TOOL_ARGUMENT_INVALID',true);return v;};
const text=(v,max=12000)=>{if(typeof v!=='string'||v.length>max)fail('TOOL_ARGUMENT_INVALID',true);return v;};
const limit=v=>v===undefined?20:(Number.isInteger(v)&&v>=1&&v<=100?v:fail('TOOL_ARGUMENT_INVALID',true));
const escapeQ=v=>v.replace(/\\/g,'\\\\').replace(/'/g,"\\'");
const plain=rich=>rich.map(x=>x.plain_text??x.text?.content??'').join('');
const bounded=data=>{if(new TextEncoder().encode(JSON.stringify(data)).length>16384)fail('TOOL_RESULT_TOO_LARGE');return data;};
function transportCode(error){
 const message=String(error?.message||'');
 if(/Illegal invocation|incorrect this/i.test(message))return 'FETCH_RECEIVER';
 if(/redirect/i.test(message))return 'REDIRECT_MODE';
 if(/DNS|resolve.*host/i.test(message))return 'DNS';
 if(/abort/i.test(message))return 'ABORTED';
 if(/network|fetch failed/i.test(message))return 'NETWORK';
 return ['TypeError','RangeError'].includes(error?.name)?error.name.toUpperCase():'UNKNOWN';
}
export function validateDocumentOperation(stationId,operation,payload={}){
 if(!DOCUMENT_OPERATIONS[stationId]?.includes(operation))fail('TOOL_OPERATION_INVALID',true);
 if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('TOOL_ARGUMENT_INVALID',true);
 const allowed={list:['folderId','limit','cursor'],search:['query','folderId','limit','cursor'],read:['fileId','pageId'],read_content:['fileId'],read_blocks:['pageId','limit','cursor'],create_text:['name','text','folderId'],update_text:['fileId','text'],create_page:['parentId','title','text'],append_text:['pageId','text']}[operation];
 const meta=['journeyId','workPassRef','workPass','actingActor','operation','cityAuthorization'];
 if(Object.keys(payload).some(k=>!allowed.includes(k)&&!meta.includes(k)))fail('TOOL_ARGUMENT_INVALID',true);
 if(stationId==='DRIVE_STATION'){
  if(['read','read_content','update_text'].includes(operation))id(payload.fileId);
  if(payload.folderId!==undefined)id(payload.folderId);
  if(operation==='create_text'){if(!text(payload.name,200).trim())fail('TOOL_ARGUMENT_INVALID',true);text(payload.text);}
  if(operation==='update_text')text(payload.text);
 }else{
  if(['read','read_blocks','append_text'].includes(operation))notionId(payload.pageId);
  if(operation==='append_text'&&!text(payload.text,2000).trim())fail('TOOL_ARGUMENT_INVALID',true);
  if(operation==='create_page'){notionId(payload.parentId);if(!text(payload.title,200).trim())fail('TOOL_ARGUMENT_INVALID',true);text(payload.text,2000);}
 }
 if(operation==='search')text(payload.query??'',200);
 if(payload.cursor!==undefined)text(payload.cursor,1024);
 if(payload.limit!==undefined)limit(payload.limit);
 return Object.fromEntries(Object.entries(payload).filter(([k])=>allowed.includes(k)));
}
export function createDocumentStations({env,fetchImpl=fetch,clock=()=>Date.now(),operationTimeoutMs=22000}={}){
 if(!Number.isFinite(operationTimeoutMs)||operationTimeoutMs<=0||operationTimeoutMs>22000)throw new Error('TOOL_TIMEOUT_INVALID');
 async function execute(station,input){
  const controller=new AbortController(),state={mutationStarted:false};let timer;
  const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{
   reject(Object.assign(new Error('DOCUMENT_OPERATION_TIMEOUT'),{notSent:!state.mutationStarted}));
   controller.abort();
  },operationTimeoutMs);});
  const adapters=createDocumentExecution({env,fetchImpl,clock,signal:controller.signal,state});
  try{return await Promise.race([adapters[station].execute(input),timeout]);}finally{clearTimeout(timer);}
 }
 return {DRIVE_STATION:{execute:input=>execute('DRIVE_STATION',input)},NOTION_STATION:{execute:input=>execute('NOTION_STATION',input)}};
}
function createDocumentExecution({env,fetchImpl,clock,signal,state}){
 let token=null,expires=0;
 async function request(url,init,provider,{raw=false,beforeMutation=true}={}){
  if(signal.aborted)fail('DOCUMENT_OPERATION_TIMEOUT',!state.mutationStarted);
  if(!beforeMutation)state.mutationStarted=true;
  let response;try{response=await fetchImpl(url,{...init,redirect:'manual',signal});}catch(error){fail(provider+'_UNREACHABLE_'+transportCode(error),beforeMutation&&!state.mutationStarted);}
  if(!response.ok&&provider!=='GOOGLE_OAUTH')fail(provider+'_HTTP_'+response.status,beforeMutation);
  if(Number(response.headers.get('content-length'))>65536)fail('TOOL_RESULT_TOO_LARGE',beforeMutation);
  const reader=response.body?.getReader();let size=0;const chunks=[];
  if(reader){try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>65536){await reader.cancel();fail('TOOL_RESULT_TOO_LARGE',beforeMutation);}chunks.push(r.value);}}finally{reader.releaseLock();}}
  const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
  const content=new TextDecoder().decode(bytes);
  if(!response.ok){
   let code='';try{const r=JSON.parse(content);if(['invalid_grant','invalid_client','invalid_request','unauthorized_client','unsupported_grant_type','invalid_scope','access_denied','temporarily_unavailable'].includes(r.error))code='_'+r.error.toUpperCase();}catch{}
   fail(provider+'_HTTP_'+response.status+code,beforeMutation);
  }
  if(raw)return content;
  try{return JSON.parse(content);}catch{fail(provider+'_RESPONSE_INVALID',beforeMutation);}
 }
 async function access(){
  if(!env.GOOGLE_CLIENT_ID||!env.GOOGLE_CLIENT_SECRET||!env.GOOGLE_REFRESH_TOKEN||!env.GOOGLE_DRIVE_ROOT_FOLDER_ID)fail('DRIVE_NOT_CONFIGURED',true);
  if(token&&expires>clock()+60000)return token;
  const r=await request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:env.GOOGLE_CLIENT_ID,client_secret:env.GOOGLE_CLIENT_SECRET,refresh_token:env.GOOGLE_REFRESH_TOKEN}).toString()},'GOOGLE_OAUTH');
  if(typeof r.access_token!=='string'||!r.access_token)fail('GOOGLE_OAUTH_RESPONSE_INVALID',true);
  token=r.access_token;expires=clock()+Math.max(0,Number(r.expires_in)||0)*1000;return token;
 }
 async function drive(path,{method='GET',body,raw=false,headers={},beforeMutation=true}={}){
  const auth=await access();return request('https://www.googleapis.com'+path,{method,headers:{authorization:'Bearer '+auth,...headers},...(body===undefined?{}:{body})},'DRIVE',{raw,beforeMutation});
 }
 async function metadata(fileId){return drive('/drive/v3/files/'+id(fileId)+'?supportsAllDrives=true&fields=id,name,mimeType,parents,trashed,modifiedTime,webViewLink');}
 async function within(fileId){
  const root=id(env.GOOGLE_DRIVE_ROOT_FOLDER_ID);let current=id(fileId),first=null;const seen=new Set();
  for(let n=0;n<30;n++){
   if(seen.has(current))fail('DRIVE_OUTSIDE_ROOT',true);seen.add(current);
   const m=await metadata(current);if(m.id!==current||m.trashed)fail('DRIVE_OUTSIDE_ROOT',true);first??=m;
   if(current===root||m.parents?.includes(root))return first;
   if(!m.parents?.length)fail('DRIVE_OUTSIDE_ROOT',true);current=id(m.parents[0]);
  }fail('DRIVE_OUTSIDE_ROOT',true);
 }
 async function content(fileId,m){
  if(m.mimeType==='application/vnd.google-apps.document')return drive('/drive/v3/files/'+id(fileId)+'/export?mimeType=text%2Fplain',{raw:true});
  if(!['text/plain','text/markdown','application/json','text/csv'].includes(m.mimeType))fail('DRIVE_CONTENT_TYPE_UNSUPPORTED',true);
  return drive('/drive/v3/files/'+id(fileId)+'?alt=media&supportsAllDrives=true',{raw:true});
 }
 async function executeDrive({operation,payload={},attemptId}){
  const p=validateDocumentOperation('DRIVE_STATION',operation,payload);await access();let data;
  if(['list','search'].includes(operation)){
   const folder=p.folderId??env.GOOGLE_DRIVE_ROOT_FOLDER_ID;if(p.folderId){const m=await within(folder);if(m.mimeType!=='application/vnd.google-apps.folder')fail('DRIVE_FOLDER_REQUIRED',true);}
   const q="trashed = false and '"+escapeQ(id(folder))+"' in parents"+(operation==='search'&&p.query?" and (name contains '"+escapeQ(p.query)+"')":'');
   const query=new URLSearchParams({q,pageSize:String(limit(p.limit)),fields:'nextPageToken,incompleteSearch,files(id,name,mimeType,modifiedTime,webViewLink)',supportsAllDrives:'true',includeItemsFromAllDrives:'true',...(p.cursor?{pageToken:p.cursor}:{})});
   data=await drive('/drive/v3/files?'+query);
  }else if(['read','read_content'].includes(operation)){
   const m=await within(p.fileId);data=operation==='read'?m:{...m,text:await content(p.fileId,m)};
  }else{
   let fileId=p.fileId;
   if(operation==='create_text'){
    const folder=p.folderId??env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
    if(p.folderId){const m=await within(folder);if(m.mimeType!=='application/vnd.google-apps.folder')fail('DRIVE_FOLDER_REQUIRED',true);}
    const boundary='metro-'+crypto.randomUUID();const meta={name:p.name,mimeType:'text/plain',parents:[id(folder)],...(attemptId?{appProperties:{metropolisAttempt:attemptId}}:{})};
    const body=['--'+boundary,'Content-Type: application/json; charset=UTF-8','',JSON.stringify(meta),'--'+boundary,'Content-Type: text/plain; charset=UTF-8','',p.text,'--'+boundary+'--',''].join('\r\n');
    const created=await drive('/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name',{method:'POST',body,headers:{'content-type':'multipart/related; boundary='+boundary},beforeMutation:false});
    try{fileId=id(created.id);}catch(e){e.notSent=false;throw e;}
   }else{
    const m=await within(fileId);if(m.mimeType!=='text/plain')fail('DRIVE_CONTENT_TYPE_UNSUPPORTED',true);
    await drive('/upload/drive/v3/files/'+id(fileId)+'?uploadType=media&supportsAllDrives=true&fields=id',{method:'PATCH',body:p.text,headers:{'content-type':'text/plain; charset=UTF-8'},beforeMutation:false});
   }
   try{const m=await within(fileId);const actual=await content(fileId,m);if(actual!==p.text||(operation==='create_text'&&m.name!==p.name))fail('DESTINATION_READBACK_UNVERIFIED');data={...m,text:actual};}catch(e){e.notSent=false;throw e;}
  }
  return {verified:true,data:bounded(data),observedAt:new Date(clock()).toISOString()};
 }
 async function notion(path,method='GET',body,beforeMutation=true){
  if(!env.NOTION_TOKEN_SECRET)fail('NOTION_NOT_CONFIGURED',true);
  return request('https://api.notion.com/v1'+path,{method,headers:{authorization:'Bearer '+env.NOTION_TOKEN_SECRET,'notion-version':'2025-09-03','content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})},'NOTION',{beforeMutation});
 }
 async function executeNotion({operation,payload={}}){
  const p=validateDocumentOperation('NOTION_STATION',operation,payload);let data;
  if(operation==='search')data=await notion('/search','POST',{query:p.query??'',page_size:limit(p.limit),...(p.cursor?{start_cursor:p.cursor}:{})});
  else if(operation==='read')data=await notion('/pages/'+p.pageId);
  else if(operation==='read_blocks')data=await notion('/blocks/'+p.pageId+'/children?'+new URLSearchParams({page_size:String(limit(p.limit)),...(p.cursor?{start_cursor:p.cursor}:{})}));
  else{
   const children=[{object:'block',type:'paragraph',paragraph:{rich_text:[{type:'text',text:{content:p.text}}]}}];
   if(operation==='create_page'){
    const created=await notion('/pages','POST',{parent:{type:'page_id',page_id:p.parentId},properties:{title:{type:'title',title:[{type:'text',text:{content:p.title}}]}},children},false);
    try{const page=await notion('/pages/'+notionId(created.id));const blocks=await notion('/blocks/'+notionId(created.id)+'/children');if(plain(page.properties?.title?.title||[])!==p.title||plain(blocks.results?.[0]?.paragraph?.rich_text||[])!==p.text)fail('DESTINATION_READBACK_UNVERIFIED');data={page,blocks};}catch(e){e.notSent=false;throw e;}
   }else{
    const appended=await notion('/blocks/'+p.pageId+'/children','PATCH',{children},false);
    try{if(appended.results?.length!==1)fail('DESTINATION_READBACK_UNVERIFIED');const blocks=[];for(const b of appended.results){const actual=await notion('/blocks/'+notionId(b.id));if(actual.id!==b.id||actual.type!=='paragraph'||plain(actual.paragraph?.rich_text||[])!==p.text)fail('DESTINATION_READBACK_UNVERIFIED');blocks.push(actual);}data={pageId:p.pageId,blocks};}catch(e){e.notSent=false;throw e;}
   }
  }
  return {verified:true,data:bounded(data),observedAt:new Date(clock()).toISOString()};
 }
 return {DRIVE_STATION:{execute:executeDrive},NOTION_STATION:{execute:executeNotion}};
}
