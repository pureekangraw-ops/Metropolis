import test from 'node:test';
import assert from 'node:assert/strict';
import {createObservatoryStation} from '../src/observatory-station.mjs';
import {createWorkPass} from '../src/work-pass.mjs';
function fixture(){
 let now=100000;const values=new Map();let alarm=null;
 const storage={get:async k=>structuredClone(values.get(k)),put:async(k,v)=>values.set(k,structuredClone(v)),delete:async k=>values.delete(k),list:async({prefix})=>new Map([...values].filter(([k])=>k.startsWith(prefix))),setAlarm:async t=>alarm=t};
 const work={workId:'W',checkpointId:'CP',ownerSystem:'OBSERVATORY',state:'RECEIVED',workPass:createWorkPass({workId:'W',checkpointId:'CP',actor:'GO'})};
 const station=createObservatoryStation({env:{MCP_PUBLIC_ORIGIN:'https://city.example'},storage,runtime:{getWork:async()=>work},clock:()=>now});
 return {station,values,advance:n=>now+=n,now:()=>now,alarm:()=>alarm};
}
const snap=(id,now)=>({schema:'observer.snapshot.v1',captureId:id,revision:1,sequence:Number(id.slice(1)),epoch:1,capturedAtEpochMs:now,tabId:'t',url:'https://example.com/?secret=x',title:'page',text:id,targets:[],truncated:false});
test('tool pairing feeds authorized Work observation without creating another Work',async()=>{
 const f=fixture(),p=await f.station.pair({actor:'GO'});
 await f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c1',f.now())});
 const read=await f.station.observe({actor:'GO',workId:'W',view:'browser'});
 assert.equal(read.snapshot.text,'c1');assert.equal(read.receipt.workId,'W');
 await assert.rejects(f.station.memory({actor:'LIGHT',action:'history',deviceId:p.deviceId,view:'browser'}),/NO_GRANT/);
});
test('rolling history retains 5-second captures, expires exactly at 15 seconds and preserves selected range',async()=>{
 const f=fixture(),p=await f.station.pair({actor:'GO'});
 for(let n=1;n<=3;n++){await f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c'+n,f.now())});if(n<3)f.advance(5000);}
 const h=await f.station.memory({actor:'GO',action:'history',view:'browser'});
 assert.equal(h.items.length,3);
 const saved=await f.station.memory({actor:'GO',action:'preserve',view:'browser',label:'before / after'});
 assert.equal(saved.items.length,3);assert.ok(saved.evidenceRef);
 f.advance(5000);await f.station.cleanup();
 assert.equal((await f.station.memory({actor:'GO',action:'history',view:'browser'})).items.length,2);
 f.advance(30000);await f.station.cleanup();
 assert.equal((await f.station.memory({actor:'GO',action:'history',view:'browser'})).items.length,0);
 const read=await f.station.memory({actor:'GO',action:'read',savedId:saved.id});
 assert.equal(read.items.length,3);assert.equal(read.items[0].snapshot.url,'https://example.com/');
 assert.equal([...f.values.keys()].some(k=>k.startsWith('observatory:history:')),false);
 assert.ok(f.alarm());
});
test('stop rejects delayed captures and cleans transient state after 30 seconds without deleting saved items',async()=>{
 const f=fixture(),p=await f.station.pair({actor:'GO'});
 await f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c1',f.now())});
 const saved=await f.station.memory({actor:'GO',action:'preserve',view:'browser'});
 await f.station.stop({deviceId:p.deviceId,token:p.token,view:'browser',epoch:1});
 await assert.rejects(f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c2',f.now())}),/SHARING_STOPPED/);
 f.advance(30000);await f.station.cleanup();
 assert.equal([...f.values.keys()].some(k=>k.startsWith('observatory:history:')||k.startsWith('observatory:transient:')),false);
 assert.equal((await f.station.memory({actor:'GO',action:'read',savedId:saved.id})).items.length,1);
});
test('cannot preserve expired capture or overwrite saved range',async()=>{
 const f=fixture(),p=await f.station.pair({actor:'GO'});
 await f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c1',f.now())});
 const saved=await f.station.memory({actor:'GO',action:'preserve',view:'browser',captureIds:['c1']});
 f.advance(15000);
 await assert.rejects(f.station.memory({actor:'GO',action:'preserve',view:'browser',captureIds:['c1']}),/CAPTURE_EXPIRED/);
 await assert.rejects(f.station.memory({actor:'LIGHT',action:'read',savedId:saved.id}),/SAVED_NOT_FOUND/);
});
test('stop tombstone survives temporary cleanup and rejects delayed session resurrection',async()=>{
 const f=fixture(),p=await f.station.pair({actor:'GO'});
 await f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c1',f.now())});
 await f.station.stop({deviceId:p.deviceId,token:p.token,view:'browser',epoch:1});
 f.advance(30000);await f.station.cleanup();
 await assert.rejects(f.station.publish({deviceId:p.deviceId,token:p.token,view:'browser',snapshot:snap('c2',f.now())}),/SHARING_STOPPED/);
});
