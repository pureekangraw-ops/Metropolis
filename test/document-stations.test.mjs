import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentStations} from '../src/document-stations.mjs';
const env={GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret',GOOGLE_REFRESH_TOKEN:'refresh',GOOGLE_DRIVE_ROOT_FOLDER_ID:'root',NOTION_TOKEN_SECRET:'notion-secret'};
const reply=v=>new Response(JSON.stringify(v),{headers:{'content-type':'application/json'}});
test('Drive search refreshes only inside Metro and constrains query to owner root',async()=>{
 const calls=[];
 const stations=createDocumentStations({env,fetchImpl:async(url,init)=>{calls.push([String(url),init]);return String(url).includes('oauth2')?reply({access_token:'private-access',expires_in:3600}):reply({files:[{id:'f',name:'Evidence'}]});}});
 const r=await stations.DRIVE_STATION.execute({operation:'search',payload:{query:"owner's report"}});
 assert.equal(r.data.files[0].id,'f');assert.equal(calls.length,2);
 assert.equal(calls[1][1].headers.authorization,'Bearer private-access');
 const q=new URL(calls[1][0]).searchParams.get('q');assert.ok(q.includes("'root' in parents"));assert.ok(q.includes("owner\\'s report"));
 assert.ok(!JSON.stringify(r).includes('private-access'));
});
test('Drive forbids files outside root before content or mutation',async()=>{
 let calls=0;
 const stations=createDocumentStations({env,fetchImpl:async(url)=>{calls++;return String(url).includes('oauth2')?reply({access_token:'access',expires_in:3600}):reply({id:'foreign',parents:[],mimeType:'text/plain'});}});
 await assert.rejects(()=>stations.DRIVE_STATION.execute({operation:'update_text',payload:{fileId:'foreign',text:'bad'}}),/DRIVE_OUTSIDE_ROOT/);
 assert.equal(calls,2);
});
test('Drive create_text verifies provider file content independently',async()=>{
 const calls=[];
 const stations=createDocumentStations({env,fetchImpl:async(url,init)=>{
  calls.push([String(url),init]);if(String(url).includes('oauth2'))return reply({access_token:'access',expires_in:3600});
  if(init.method==='POST')return reply({id:'created',name:'Test'});
  if(new URL(url).searchParams.get('alt')==='media')return new Response('hello');
  return reply({id:'created',name:'Test',parents:['root'],mimeType:'text/plain'});
 }});
 const r=await stations.DRIVE_STATION.execute({operation:'create_text',payload:{name:'Test',text:'hello'},attemptId:'ATT-test'});
 assert.equal(r.verified,true);assert.equal(r.data.text,'hello');assert.ok(calls.some(x=>x[0].includes('alt=media')));
});
test('Notion missing credential proves no provider request was sent',async()=>{
 let calls=0;const s=createDocumentStations({env:{},fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>s.NOTION_STATION.execute({operation:'search',payload:{query:'GO'}}),e=>e.message==='NOTION_NOT_CONFIGURED'&&e.notSent===true);
 assert.equal(calls,0);
});
test('Notion ignores the obsolete binding name instead of sending an unconfigured request',async()=>{
 let calls=0;const s=createDocumentStations({env:{NOTION_TOKEN:'legacy'},fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>s.NOTION_STATION.execute({operation:'search',payload:{query:'GO'}}),e=>e.message==='NOTION_NOT_CONFIGURED'&&e.notSent===true);
 assert.equal(calls,0);
});
test('Notion append verifies exact returned blocks through a separate provider read',async()=>{
 const page='a'.repeat(32),block='b'.repeat(32);let reads=0;
 const s=createDocumentStations({env,fetchImpl:async(url,init)=>{
  assert.equal(init.headers.authorization,'Bearer notion-secret');
  if(init.method==='PATCH')return reply({results:[{id:block}]});
  reads++;return reply({id:block,type:'paragraph',paragraph:{rich_text:[{plain_text:'note'}]}});
 }});
 const r=await s.NOTION_STATION.execute({operation:'append_text',payload:{pageId:page,text:'note'}});
 assert.equal(reads,1);assert.equal(r.verified,true);assert.equal(r.data.blocks[0].id,block);
});
test('arbitrary URL and unknown operation never reach network',async()=>{
 let calls=0;const s=createDocumentStations({env,fetchImpl:async()=>{calls++;}});
 await assert.rejects(()=>s.DRIVE_STATION.execute({operation:'fetch',payload:{url:'https://evil.example'}}),/TOOL_OPERATION_INVALID/);
 await assert.rejects(()=>s.NOTION_STATION.execute({operation:'read',payload:{pageId:'https://evil.example'}}),/TOOL_ARGUMENT_INVALID/);
 assert.equal(calls,0);
});
test('malformed create response cannot turn a possible write into a safe retry',async()=>{
 const s=createDocumentStations({env,fetchImpl:async url=>String(url).includes('oauth2')?reply({access_token:'a',expires_in:3600}):reply({})});
 await assert.rejects(()=>s.DRIVE_STATION.execute({operation:'create_text',payload:{name:'test',text:'note'}}),e=>e.notSent===false);
});
test('bounded transport rejects oversized provider results without claiming verification',async()=>{
 const s=createDocumentStations({env,fetchImpl:async()=>reply({results:[{text:'x'.repeat(18000)}]})});
 await assert.rejects(()=>s.NOTION_STATION.execute({operation:'search',payload:{}}),/TOOL_RESULT_TOO_LARGE/);
});
test('operation-wide deadline aborts a slow write and preserves ambiguous outcome',async()=>{
 let aborted=false;
 const s=createDocumentStations({env,operationTimeoutMs:30,fetchImpl:async(url,init)=>{
  if(String(url).includes('oauth2'))return reply({access_token:'a',expires_in:3600});
  return new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});});
 }});
 await assert.rejects(()=>s.DRIVE_STATION.execute({operation:'create_text',payload:{name:'Test',text:'note'}}),e=>e.notSent===false);
 assert.equal(aborted,true);
});
test('provider requests use manual redirect handling accepted by the deployed runtime',async()=>{
 const s=createDocumentStations({env,fetchImpl:async(url,init)=>{
  if(init.redirect!=='manual')throw new TypeError('redirect mode is not supported');
  return String(url).includes('oauth2')?reply({access_token:'a',expires_in:3600}):reply({files:[]});
 }});
 assert.equal((await s.DRIVE_STATION.execute({operation:'list',payload:{limit:1}})).verified,true);
});
test('OAuth rejection exposes only allowlisted error code, not provider description',async()=>{
 const s=createDocumentStations({env,fetchImpl:async()=>new Response(JSON.stringify({error:'invalid_grant',error_description:'sensitive provider details'}),{status:400})});
 await assert.rejects(()=>s.DRIVE_STATION.execute({operation:'list',payload:{}}),e=>e.message==='GOOGLE_OAUTH_HTTP_400_INVALID_GRANT'&&e.notSent===true);
});
