export const STATION_BRANCH_MODEL_VERSION='1.0.0';
export const STATION_BRANCH_MODEL_STATUS='LOCKED';
export const STATION_JOURNEY_SCHEMA='STATION_JOURNEY_V1'; export const STATION_JOURNEY_STATUS=Object.freeze({IN_TRANSIT:'IN_TRANSIT',RETURNED:'RETURNED'});
const text=value=>String(value??'').trim(); const clone=value=>value==null?value:structuredClone(value); const unique=values=>[...new Set((Array.isArray(values)?values:[]).map(text).filter(Boolean))];
export function normalizeJourneyBaggage(value={}){const s=value&&typeof value==='object'&&!Array.isArray(value)?value:{};return Object.freeze({payloadRefs:Object.freeze(unique(s.payloadRefs||s.inputRefs||[])),artifactRefs:Object.freeze(unique(s.artifactRefs||[])),evidenceRefs:Object.freeze(unique(s.evidenceRefs||[])),receiptRefs:Object.freeze(unique(s.receiptRefs||[]))});}
export function createStationJourney({journeyId,workId,checkpointId,stationId,destinationId=null,actor=null,branchProfile=null,baggage={},inAt=new Date().toISOString()}={}){
 const id=text(journeyId); if(!id) throw new Error('JOURNEY_ID_REQUIRED');
 return Object.freeze({schema:STATION_JOURNEY_SCHEMA,journeyId:id,workId:text(workId),checkpointId:text(checkpointId),stationId:text(stationId),destinationId:destinationId==null?null:text(destinationId),actor:actor==null?null:text(actor),match:true,matchBasis:'WORK_ID_CHECKPOINT_CORRELATION',status:STATION_JOURNEY_STATUS.IN_TRANSIT,inAt,outAt:null,branchProfile:clone(branchProfile),baggageIn:normalizeJourneyBaggage(baggage),baggageOut:normalizeJourneyBaggage(),diagnostic:null});
}
export function closeStationJourney(journey,{baggage={},diagnostic=null,outAt=new Date().toISOString()}={}){if(!journey||journey.schema!==STATION_JOURNEY_SCHEMA) throw new Error('STATION_JOURNEY_REQUIRED');return Object.freeze({...clone(journey),status:STATION_JOURNEY_STATUS.RETURNED,outAt,baggageOut:normalizeJourneyBaggage(baggage),diagnostic:clone(diagnostic)});}
