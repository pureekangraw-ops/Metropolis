// PIXIE-owned ephemeral cargo slots. No Work records, source evidence or receipts are deleted.
const keyFor = slot => {
  if (typeof slot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(slot)) throw new Error('PIXIE_SLOT_INVALID');
  return 'pixie:ephemeral:' + slot;
};
export function createPixieEphemeralSlots({storage,clock=()=>Date.now(),maxAgeMs=15000}={}) {
  if (!storage?.get || !storage?.put || !storage?.delete) throw new Error('PIXIE_DELETE_CAPABLE_STORAGE_REQUIRED');
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000) throw new Error('PIXIE_TTL_INVALID');
  async function read(slot) {
    const key=keyFor(slot),record=await storage.get(key);
    if (!record) return {status:'EMPTY',slot};
    const ageMs=clock()-record.acceptedAtEpochMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) {
      await storage.delete(key);
      return {status:'EXPIRED',slot,deleted:true};
    }
    return {status:'CURRENT',slot,ageMs,value:structuredClone(record.value)};
  }
  async function replace(slot,value) {
    const key=keyFor(slot);
    if (value===undefined || value===null) throw new Error('PIXIE_VALUE_REQUIRED');
    // One physical key: replacing the value does not accumulate older snapshots.
    const record={acceptedAtEpochMs:clock(),value:structuredClone(value)};
    await storage.put(key,record);
    const actual=await storage.get(key);
    if (JSON.stringify(actual)!==JSON.stringify(record)) throw new Error('PIXIE_WRITE_READBACK_FAILED');
    return {status:'CURRENT',slot,acceptedAtEpochMs:record.acceptedAtEpochMs};
  }
  async function clear(slot) {
    const key=keyFor(slot);
    await storage.delete(key);
    return {status:'EMPTY',slot,deleted:true};
  }
  async function sweep(slots) {
    if (!Array.isArray(slots)) throw new Error('PIXIE_SLOTS_REQUIRED');
    const expired=[];
    for (const slot of slots) if ((await read(slot)).status==='EXPIRED') expired.push(slot);
    return {expired,deleted:expired.length};
  }
  return Object.freeze({read,replace,clear,sweep,maxAgeMs});
}
