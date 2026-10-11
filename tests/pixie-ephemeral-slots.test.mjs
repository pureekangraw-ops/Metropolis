import test from 'node:test';
import assert from 'node:assert/strict';
import {createPixieEphemeralSlots} from '../src/pixie/ephemeral-slots.mjs';

function setup() {
  let now=100000;
  const data=new Map();
  const storage={
    async get(k){return data.get(k)},
    async put(k,v){data.set(k,structuredClone(v))},
    async delete(k){data.delete(k)}
  };
  return {data,storage,advance:ms=>{now+=ms},pixie:createPixieEphemeralSlots({storage,clock:()=>now,maxAgeMs:15000})};
}
test('GOLDEN: only latest value survives physical replacement',async()=>{
  const s=setup();
  await s.pixie.replace('eye:browser',{sequence:1});
  await s.pixie.replace('eye:browser',{sequence:2});
  assert.equal(s.data.size,1);
  assert.deepEqual((await s.pixie.read('eye:browser')).value,{sequence:2});
});
test('GOLDEN: snapshot expires and is physically deleted after 15s',async()=>{
  const s=setup();
  await s.pixie.replace('eye:browser',{sequence:1});
  s.advance(15001);
  assert.deepEqual(await s.pixie.read('eye:browser'),{status:'EXPIRED',slot:'eye:browser',deleted:true});
  assert.equal(s.data.size,0);
});
test('GOLDEN: fresh snapshot is not prematurely deleted',async()=>{
  const s=setup();
  await s.pixie.replace('eye:browser',{sequence:1});
  s.advance(15000);
  assert.equal((await s.pixie.read('eye:browser')).status,'CURRENT');
});
test('GOLDEN: sweep only removes expired ephemeral slots',async()=>{
  const s=setup();
  await s.pixie.replace('eye:old',{sequence:1});
  s.advance(12000);
  await s.pixie.replace('eye:new',{sequence:2});
  s.advance(4000);
  assert.deepEqual(await s.pixie.sweep(['eye:old','eye:new']),{expired:['eye:old'],deleted:1});
  assert.equal((await s.pixie.read('eye:new')).status,'CURRENT');
});
test('GOLDEN: invalid slot cannot reach other city records',async()=>{
  const s=setup();
  await assert.rejects(s.pixie.clear('../work:owner'),/PIXIE_SLOT_INVALID/);
  assert.equal(s.data.size,0);
});
