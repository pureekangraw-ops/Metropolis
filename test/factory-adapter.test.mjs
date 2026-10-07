import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryRailAdapter } from '../src/stations/factory.mjs';

const station={stationId:'FACTORY_STATION',ownerSystem:'FACTORY'}; const rail={railId:'RAIL-FACTORY'};
test('Factory adapter probes live-ready shape', async()=>{
 const adapter=createFactoryRailAdapter({baseUrl:'https://factory.example',sharedSecret:'secret',fetchImpl:async()=>new Response(JSON.stringify({status:'READY',storage:{status:'READY'},transport:{status:'READY'},sourceSha:'abc'}),{status:200})});
 const s=await adapter.probe({station,rail}); assert.equal(s.status,'READY'); assert.equal(s.capabilities.FACTORY_HANDOFF.status,'READY');
});
test('Factory adapter dispatches handoff and verifies readback', async()=>{
 const calls=[]; const adapter=createFactoryRailAdapter({baseUrl:'https://factory.example',sharedSecret:'secret',fetchImpl:async(url,init={})=>{calls.push([url,init.method||'GET']); if(url.endsWith('/station/receive')) return new Response(JSON.stringify({receipt:{receiptId:'receipt-1'}}),{status:202}); return new Response(JSON.stringify({receiptId:'receipt-1',workId:'WORK-1',checkpointId:'CP-1',workPassRef:'work-pass://PASS-1',sourceSha:'sha-1',stationId:'FACTORY-STATION',boundaryVerified:true,evidenceRef:'evidence://1'}),{status:200});}});
 const transport={payload:{workId:'WORK-1',checkpointId:'CP-1',workPassRef:'work-pass://PASS-1',expectedSourceSha:'sha-1'}}; const receipt=await adapter.dispatch({transport}); const rb=await adapter.readback({transport,receipt});
 assert.equal(receipt.accepted,true); assert.equal(rb.verified,true); assert.equal(rb.evidenceRef,'evidence://1'); assert.deepEqual(calls.map(x=>x[1]),['POST','GET']);
});
