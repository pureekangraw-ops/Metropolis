export const TRANSPORT_STATE = Object.freeze({
  REQUEST: 'REQUEST', ACCEPTED: 'ACCEPTED', DISPATCHED: 'DISPATCHED', RECEIPT: 'RECEIPT', READBACK: 'READBACK', FAILED: 'FAILED',
});
const TRANSITIONS = Object.freeze({
  REQUEST: new Set(['ACCEPTED','FAILED']), ACCEPTED: new Set(['DISPATCHED','FAILED']), DISPATCHED: new Set(['RECEIPT','FAILED']),
  RECEIPT: new Set(['READBACK','FAILED']), READBACK: new Set([]), FAILED: new Set([]),
});
function requiredString(value,name){ if(typeof value!=='string'||value.trim()==='') throw new TypeError(`${name}_REQUIRED`); return value.trim(); }
export function createTransportRequest({ transportId, workId, actor, stationId, railId, operation, requestedAt }) {
  return Object.freeze({ kind:'TRANSPORT', transportId:requiredString(transportId,'transportId'), workId:requiredString(workId,'workId'),
    actor:requiredString(actor,'actor'), stationId:requiredString(stationId,'stationId'), railId:requiredString(railId,'railId'),
    operation:requiredString(operation,'operation'), state:TRANSPORT_STATE.REQUEST, timestamps:{requestedAt:requiredString(requestedAt,'requestedAt')},
    receipt:null,evidenceRef:null,failure:null });
}
export function advanceTransport(transport,nextState,patch={}){
  if(!transport||!TRANSITIONS[transport.state]?.has(nextState)) throw new Error(`TRANSPORT_INVALID_TRANSITION:${transport?.state||'UNKNOWN'}:${nextState}`);
  return Object.freeze({...transport,...patch,state:nextState});
}
export function failTransport(transport,failure,failedAt){
  return advanceTransport(transport,TRANSPORT_STATE.FAILED,{timestamps:{...transport.timestamps,failedAt},
    failure:{stage:requiredString(failure.stage,'failure.stage'),code:requiredString(failure.code,'failure.code'),message:String(failure.message||'')}});
}
