import {
  createCargoEnvelope,
  deliverCargo,
  createMailbox,
  createPostOfficeBranch,
  deliverBranchCargo,
  MAILBOX_STATUS,
} from './post-office.mjs';
import { prepareMimirReturn } from './agents/mimir/return-desk.mjs';
import { rotatePixieData } from './pixie/data-lifecycle.mjs';
import { createPixieReport, createPixieStationDiagnostic } from './pixie/report-router.mjs';
import { createStationJourney, closeStationJourney, normalizeJourneyBaggage } from './station-journey.mjs';
import { createHermesIntakeDesk } from './agents/hermes/intake-desk.mjs';
import { cancelWorkPass, completeWorkPass, createWorkPass, workPassRef } from './work-pass.mjs';

export const CITY_COMPONENTS = Object.freeze(['METROPOLIS', 'CITY_HALL', 'WORK_SYSTEM', 'POST_OFFICE', 'PIXIE_SERVICE', 'SHOP', 'SPECTRUMSALE', 'THE_TAILOR']);
export const WORK_STATE = Object.freeze({RECEIVED:'RECEIVED',HANDED_OFF:'HANDED_OFF',RETURN_REVIEW:'RETURN_REVIEW',RETURNED:'RETURNED',COMPLETED:'COMPLETED',CANCELLED:'CANCELLED',UNKNOWN:'UNKNOWN'});

function text(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`);
  return value.trim();
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }

export function createMemoryStore() {
  const records = new Map();
  return Object.freeze({
    async get(key) { return clone(records.get(text(key, 'key'))); },
    async put(key, value) { records.set(text(key, 'key'), clone(value)); return clone(value); },
    async list(prefix = '') { return [...records.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: clone(value) })); },
  });
}

export function createRailLink({ railId, endpoints, trustBoundary } = {}) {
  const id = text(railId, 'railId');
  if (!Array.isArray(endpoints) || endpoints.length !== 2) throw new TypeError('rail_endpoints_MUST_HAVE_EXACTLY_TWO');
  const normalized = endpoints.map((endpoint) => Object.freeze({ stationId: text(endpoint.stationId, 'endpoint.stationId'), systemId: text(endpoint.systemId, 'endpoint.systemId') }));
  if (normalized[0].stationId === normalized[1].stationId) throw new Error('rail_endpoints_MUST_BE_DISTINCT');
  return Object.freeze({ kind: 'RAIL_LINK', railId: id, endpoints: Object.freeze(normalized), trustBoundary: text(trustBoundary, 'trustBoundary') });
}

export function createCityMap() {
  return Object.freeze({
    city: 'METROPOLIS',
    components: CITY_COMPONENTS,
    stations: Object.freeze(['METROPOLIS_STATION', 'FACTORY_STATION', 'PRISM_STATION', 'DRIVE_STATION', 'NOTION_STATION']),
    paths: Object.freeze(['SHOP_TO_HALL', 'TAILOR_TO_HALL', 'HALL_TO_PIXIE_SERVICE', 'HALL_TO_STATION', 'POST_OFFICE_TO_MAILBOX']),
    rails: Object.freeze([]),
  });
}

export function createCityRuntime({ store = createMemoryStore(), clock = () => new Date().toISOString(), idFactory = () => crypto.randomUUID(), sourceSha = 'UNKNOWN', stationRuntimes = {}, tabletRuntime = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new TypeError('store_REQUIRED');
  const mailboxes = new Map();
  const stations = Object.freeze({ ...stationRuntimes });

  async function intake({ workId = idFactory(), checkpointId, ownerSystem, requestedBy = 'UNKNOWN', workPassActor = null, inputRefs = [], intakeDraftId = null, intakeInformation = {} } = {}) {
    const id = text(workId, 'workId');
    const owner = text(ownerSystem, 'ownerSystem');
    const existing = await store.get(`work:${id}`);
    if (existing) throw new Error('WORK_ALREADY_EXISTS');
    const now = clock();
    const cp = checkpointId == null ? `${id}:CP-01` : text(checkpointId, 'checkpointId');
    const pass = workPassActor == null ? null : createWorkPass({
      workId: id,
      checkpointId: cp,
      actor: text(workPassActor, 'workPassActor'),
      issuedAt: now,
      handoffStations: owner === 'GOOGLE_DRIVE' ? ['DRIVE_STATION'] : ['FACTORY_STATION'],
    });
    const dataLifecycle = rotatePixieData([], {
      dataId: `${id}:DATA:COUNTER:1`,
      workId: id,
      checkpointId: cp,
      producer: 'COUNTER',
      kind: 'INTAKE',
      payloadRef: inputRefs[0] || null,
      ownerSystem: owner,
      truthOwner: owner,
      createdAt: now,
    });
    const baseRecord = {
      kind: 'WORK_RECORD',
      workId: id,
      ownerSystem: owner,
      requestedBy: text(requestedBy, 'requestedBy'),
      state: WORK_STATE.RECEIVED,
      checkpointId: cp,
      inputRefs: [...inputRefs],
      intakeDraftId: intakeDraftId == null ? null : text(intakeDraftId, 'intakeDraftId'),
      intake: intakeDraftId == null ? null : {
        draftId: text(intakeDraftId, 'intakeDraftId'),
        title: typeof intakeInformation?.title === 'string' ? intakeInformation.title.trim() || null : null,
        summary: typeof intakeInformation?.summary === 'string' ? intakeInformation.summary.trim() || null : null,
      },
      handoff:null, returnReview:null, stationReturnReview:null, return:null,
      online:{status:'ONLINE',activation:'NEW',announcedBy:'HERMES',activatedAt:now,lastAnnouncedAt:now},
      journeys:[], reports:[], dataLifecycle,
      workPass: clone(pass),
      workPassRef: workPassRef(pass),
      tablet: null,
      history: [{ state: WORK_STATE.RECEIVED, at: now }],
      sourceSha,
      updatedAt: now,
    };
    await store.put(`work:${id}`, baseRecord);

    let tablet = null;
    if (tabletRuntime?.issue) {
      try {
        tablet = await tabletRuntime.issue(baseRecord, { actor: 'HERMES' });
      } catch (error) {
        tablet = {
          status: 'UNKNOWN',
          verified: false,
          reason: 'TABLET_ISSUE_FAILED',
          errorCode: error?.message || 'UNKNOWN',
        };
      }
    }
    const record = {
      ...baseRecord,
      tablet: clone(tablet),
      updatedAt: clock(),
    };
    await store.put(`work:${id}`, record);
    return clone(record);
  }

  async function resumeWork({workId,actor='HERMES'}={}) {
    const id=text(workId,'workId'); const record=await store.get(`work:${id}`);
    if(!record) throw new Error('WORK_NOT_FOUND');
    if([WORK_STATE.CANCELLED,WORK_STATE.COMPLETED].includes(record.state)) throw new Error('WORK_CLOSED');
    const now=clock();
    const next={...record,online:{status:'ONLINE',activation:'RESUME',announcedBy:'HERMES',activatedAt:now,lastAnnouncedAt:now},
      history:[...(record.history||[]),{event:'WORK_ONLINE',activation:'RESUME',at:now}],updatedAt:now};
    await store.put(`work:${id}`,next); return clone(next);
  }

  async function handoff({workId,checkpointId,stationId,operation,actor='HERMES',payload={}}={}) {
    const id=text(workId,'workId'); const record=await store.get(`work:${id}`);
    if(!record) throw new Error('WORK_NOT_FOUND');
    if(record.checkpointId!==text(checkpointId,'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');
    if(record.online?.status!=='ONLINE') throw new Error('WORK_NOT_ONLINE');
    const station=text(stationId,'stationId'); const op=text(operation,'operation'); const stationRuntime=stations[station]; const now=clock();
    // Stage inline cargo only inside the existing Work/Station boundary. Remove
    // content before journaling Work, reports or receipts; retain only its R2 ref.
    const routePayload=clone(payload);
    if(stationRuntime?.stage && Object.hasOwn(routePayload,'content')){
      const pass=record.workPass;
      const staged=await stationRuntime.stage({
        workId:id,checkpointId:record.checkpointId,actor,operation:op,
        payload:{...routePayload,workPass:clone(pass),workPassRef:workPassRef(pass)},
      });
      routePayload.payloadRef=staged.payloadRef;
      delete routePayload.content;
    }
    const journey=createStationJourney({
      journeyId:`${id}:JOURNEY:${(record.journeys||[]).length+1}`,workId:id,checkpointId:record.checkpointId,stationId:station,
      destinationId:stationRuntime?.profile?.destinationId||record.ownerSystem||null,actor,branchProfile:stationRuntime?.profile||null,
      baggage:{payloadRefs:routePayload.payloadRefs||routePayload.inputRefs||(routePayload.payloadRef?[routePayload.payloadRef]:[]),artifactRefs:routePayload.artifactRefs||[],evidenceRefs:routePayload.evidenceRefs||[],receiptRefs:routePayload.receiptRefs||[]},inAt:now,
    });
    const passRef=workPassRef(record.workPass);
    const transportPayload={...routePayload,journeyId:journey.journeyId,workPassRef:passRef,workPass:clone(record.workPass)};
    const external=stationRuntime?.handoff?await stationRuntime.handoff({workId:id,checkpointId:record.checkpointId,stationId:station,operation:op,actor,payload:transportPayload}):null;
    // Post Office issues a delivery receipt only AFTER Drive provider readback.
    // Postal delivery is not proof of CODE/VISUAL/LOGIC machine execution.
    let postal=null;
    if(station==='DRIVE_STATION'&&external?.storageVerified===true&&external?.verified===true){
      const from=createPostOfficeBranch({branchId:'CENTRAL_POST_OFFICE',systemId:'METROPOLIS',role:'CENTRAL_OFFICE'});
      const to=createPostOfficeBranch({branchId:'DRIVE_POST_OFFICE',systemId:'GOOGLE_DRIVE',role:'SUB_OFFICE'});
      const mailbox=createMailbox({mailboxId:'DRIVE_INBOX',owner:'GOOGLE_DRIVE',receiver:'GOOGLE_DRIVE'});
      const cargo=createCargoEnvelope({
        dataId:`${id}:DRIVE:${record.checkpointId}:${(record.journeys||[]).length+1}`,
        dataKind:transportPayload.dataKind,
        payloadRef:transportPayload.payloadRef,
        owner:record.ownerSystem,sender:'CENTRAL_POST_OFFICE',
        receiver:'GOOGLE_DRIVE',mailbox:mailbox.mailboxId,
        originBranch:from.branchId,destinationBranch:to.branchId,
      });
      postal=deliverBranchCargo(cargo,{originBranch:from,destinationBranch:to,mailbox,receiptId:idFactory(),observedAt:external.observedAt||now});
    }
    const handoff={handoffId:idFactory(),journeyId:journey.journeyId,actor:text(actor,'actor'),stationId:station,operation:op,payload:transportPayload,workPassRef:passRef,external:clone(external),postal:clone(postal),createdAt:now};
    let reports=[...(record.reports||[])]; let dataLifecycle=[...(record.dataLifecycle||[])];
    if(external){
      const reportId=`${id}:PIXIE:HANDOFF:${reports.length+1}`;
      const report=createPixieReport({reportId,workId:id,checkpointId:record.checkpointId,ownerSystem:record.ownerSystem,sourceTool:station,status:external.verified===true?'VERIFIED':'UNKNOWN',result:external,evidenceRefs:external.evidenceRef?[external.evidenceRef]:[],receiptRefs:external.receiptId?[external.receiptId]:[],observedAt:now});
      reports=[...reports,report];
      dataLifecycle=rotatePixieData(dataLifecycle,{dataId:`${id}:DATA:PIXIE:${reports.length}`,workId:id,checkpointId:record.checkpointId,producer:'PIXIE',kind:'TOOL_REPORT',payloadRef:`pixie-report://${reportId}`,evidenceRefs:report.evidenceRefs,ownerSystem:record.ownerSystem,truthOwner:record.ownerSystem,createdAt:now});
    }
    const next={...record,state:WORK_STATE.HANDED_OFF,handoff,stationReturnReview:null,journeys:[...(record.journeys||[]),journey],reports,dataLifecycle,
      history:[...record.history,{state:WORK_STATE.HANDED_OFF,journeyId:journey.journeyId,at:now}],updatedAt:now};
    await store.put(`work:${id}`,next); return clone(next);
  }

  async function returnWork({workId,checkpointId,readback=null,evidenceRefs=[],updates=[],stationReviewed=false,actor='GO'}={}) {
    const id=text(workId,'workId'); let record=await store.get(`work:${id}`);
    if(!record) throw new Error('WORK_NOT_FOUND');
    if(record.checkpointId!==text(checkpointId,'checkpointId')) throw new Error('CHECKPOINT_MISMATCH');
    let review=record.stationReturnReview;
    if(!review||review.status!=='GO_REVIEW_REQUIRED'||(stationReviewed!==true&&review.verified!==true)){
      const stationRuntime=stations[record.handoff?.stationId]; let trustedReadback=clone(readback); let trustedVerified=false;
      const trustedEvidence=[...new Set((Array.isArray(evidenceRefs)?evidenceRefs:[]).filter(Boolean))];
      if(stationRuntime?.readback&&record.handoff?.external){
        trustedReadback=await stationRuntime.readback({workId:id,checkpointId:record.checkpointId,handoff:clone(record.handoff)});
        trustedVerified=trustedReadback?.verified===true&&trustedReadback?.domainVerified===true;
        if(trustedReadback?.evidenceRef&&!trustedEvidence.includes(trustedReadback.evidenceRef)) trustedEvidence.push(trustedReadback.evidenceRef);
      }
      const now=clock();
      const journeyList=[...(record.journeys||[])];
      const openIndex=journeyList.map(j=>j?.status).lastIndexOf('IN_TRANSIT');
      const reviewIndex=review?.journeyId ? journeyList.findIndex(j=>j?.journeyId===review.journeyId) : -1;
      const journeyIndex=openIndex>=0?openIndex:reviewIndex;
      const openJourney=journeyIndex>=0?journeyList[journeyIndex]:null;
      const artifactRefs=Array.isArray(trustedReadback?.result?.artifactRefs)?trustedReadback.result.artifactRefs:[]; const receiptRefs=record.handoff?.external?.receiptId?[record.handoff.external.receiptId]:[];
      const baggageOut=normalizeJourneyBaggage({artifactRefs,evidenceRefs:trustedEvidence,receiptRefs});
      const diagnostic=createPixieStationDiagnostic({diagnosticId:`${id}:PIXIE:DIAGNOSTIC:${(record.reports||[]).length+1}`,workId:id,checkpointId:record.checkpointId,journeyId:openJourney?.journeyId||record.handoff?.journeyId||null,stationId:record.handoff?.stationId||null,before:openJourney?.baggageIn||{},after:baggageOut,unreadableRefs:trustedVerified?[]:['OWNER_EXECUTION_NOT_VERIFIED'],observedAt:now});
      const reportId=`${id}:PIXIE:RETURN:${(record.reports||[]).length+1}`;
      const report=createPixieReport({reportId,workId:id,checkpointId:record.checkpointId,ownerSystem:record.ownerSystem,sourceTool:record.handoff?.stationId||'RETURN_DESK',status:trustedVerified?'VERIFIED':'UNKNOWN',result:trustedReadback,artifactRefs,evidenceRefs:trustedEvidence,receiptRefs,unknowns:trustedVerified?[]:['OWNER_EXECUTION_NOT_VERIFIED'],observedAt:now});
      const reports=[...(record.reports||[]),report];
      const dataLifecycle=rotatePixieData(record.dataLifecycle||[],{dataId:`${id}:DATA:PIXIE:${reports.length}`,workId:id,checkpointId:record.checkpointId,producer:'PIXIE',kind:'TOOL_REPORT',payloadRef:`pixie-report://${reportId}`,evidenceRefs:report.evidenceRefs,ownerSystem:record.ownerSystem,truthOwner:record.ownerSystem,createdAt:now});
      const journeys=[...(record.journeys||[])];
      if(openJourney) journeys[journeyIndex]=closeStationJourney(openJourney,{baggage:baggageOut,diagnostic,outAt:openJourney.outAt||now});
      review={kind:'STATION_RETURN_REVIEW',status:'GO_REVIEW_REQUIRED',stationId:record.handoff?.stationId||null,journeyId:openJourney?.journeyId||record.handoff?.journeyId||null,match:true,outAt:now,counts:clone(diagnostic.counts),diagnostic:clone(diagnostic),readback:clone(trustedReadback),evidenceRefs:[...trustedEvidence],verified:trustedVerified,prompt:'CHECK_RETURNED_ITEMS; ADD_UPDATES_IF_ANY; OTHERWISE_PASS'};
      record={...record,state:WORK_STATE.RETURN_REVIEW,stationReturnReview:review,journeys,reports,dataLifecycle,history:[...(record.history||[]),{state:WORK_STATE.RETURN_REVIEW,journeyId:review.journeyId,at:now}],updatedAt:now};
      await store.put(`work:${id}`,record);
    }
    if(stationReviewed!==true) return clone(record);
    const now=clock();
    const organized=prepareMimirReturn({workId:id,checkpointId:record.checkpointId,journeyId:review.journeyId,readback:review.readback,evidenceRefs:review.evidenceRefs||[],updates,observedAt:now});
    let dataLifecycle=rotatePixieData(record.dataLifecycle||[],{dataId:`${id}:DATA:MIMIR:${(record.reports||[]).length}`,workId:id,checkpointId:record.checkpointId,producer:'MIMIR',kind:'RETURN_PACKET',payloadRef:`mimir-return://${id}/${record.checkpointId}`,evidenceRefs:review.evidenceRefs||[],ownerSystem:record.ownerSystem,truthOwner:record.ownerSystem,createdAt:now});
    let postal=null;
    if(record.handoff?.stationId==='FACTORY_STATION'){
      const originBranch=createPostOfficeBranch({branchId:'FACTORY_POST_OFFICE',systemId:'FACTORY',role:'SUB_OFFICE'});
      const destinationBranch=createPostOfficeBranch({branchId:'CENTRAL_POST_OFFICE',systemId:'METROPOLIS',role:'CENTRAL_OFFICE'});
      const mailbox=createMailbox({mailboxId:'HALL_RETURN_MAILBOX',owner:'CITY_HALL',receiver:'CITY_HALL'});
      const cargo=createCargoEnvelope({dataId:`${id}:RETURN:CARGO:${(record.reports||[]).length}`,dataKind:'RESULT',payloadRef:`mimir-return://${id}/${record.checkpointId}`,owner:record.ownerSystem,sender:'FACTORY_POST_OFFICE',receiver:'CITY_HALL',mailbox:mailbox.mailboxId,originBranch:originBranch.branchId,destinationBranch:destinationBranch.branchId});
      postal=deliverBranchCargo(cargo,{originBranch,destinationBranch,mailbox,receiptId:idFactory(),observedAt:now});
      if(postal.status==='DELIVERED'&&postal.receipt?.receiptId) dataLifecycle=rotatePixieData(dataLifecycle,{dataId:`${id}:DATA:POST_OFFICE:${(record.reports||[]).length}`,workId:id,checkpointId:record.checkpointId,producer:'POST_OFFICE',kind:'DELIVERY_RECEIPT',payloadRef:`post-office://${postal.receipt.receiptId}`,evidenceRefs:[],ownerSystem:record.ownerSystem,truthOwner:record.ownerSystem,createdAt:now});
    }
    const state=review.verified?WORK_STATE.RETURNED:WORK_STATE.UNKNOWN;
    const next={...record,state,returnReview:clone(organized),stationReturnReview:{...clone(review),status:'GO_REVIEWED',reviewedBy:text(actor,'actor'),reviewedAt:now},dataLifecycle,
      return:{actor:text(actor,'actor'),readback:clone(review.readback),evidenceRefs:[...(review.evidenceRefs||[])],organized:clone(organized.organized),postal:clone(postal),verified:review.verified===true,returnedAt:now},
      history:[...(record.history||[]),{state,journeyId:review.journeyId,at:now}],updatedAt:now};
    await store.put(`work:${id}`,next); return clone(next);
  }

  function registerMailbox(input) {
    const mailbox = createMailbox(input);
    mailboxes.set(mailbox.mailboxId, mailbox);
    return clone(mailbox);
  }

  async function sendCargo(input) {
    const envelope = createCargoEnvelope(input);
    const mailbox = mailboxes.get(envelope.mailbox);
    return clone(deliverCargo(envelope, { mailbox, receiptId: idFactory(), observedAt: clock() }));
  }

  async function getWork(workId) { return store.get(`work:${text(workId, 'workId')}`); }

  async function listWorks() {
    if (typeof store.list !== 'function') throw new Error('WORK_LIST_NOT_SUPPORTED');
    const rows = await store.list('work:');
    return rows.map(row => clone(row?.value)).filter(Boolean);
  }

  async function cancelWork({workId,actor='MIMIR',requestedBy=null}={}) {
    const id=text(workId,'workId'); const record=await store.get(`work:${id}`); if(!record) throw new Error('WORK_NOT_FOUND'); if(record.state===WORK_STATE.CANCELLED) return clone(record);
    const now=clock(); const next={...record,state:WORK_STATE.CANCELLED,online:{...(record.online||{}),status:'OFFLINE',closure:'CANCEL',closedAt:now,closedBy:'MIMIR'},
      workPass:cancelWorkPass(record.workPass,{cancelledAt:now,cancelledBy:'MIMIR'}),cancellation:{actor:'MIMIR',requestedBy:requestedBy||actor,cancelledAt:now},history:[...(record.history||[]),{state:WORK_STATE.CANCELLED,actor:'MIMIR',at:now}],updatedAt:now};
    await store.put(`work:${id}`,next); return clone(next);
  }
  async function completeWork({workId,actor='MIMIR',requestedBy=null}={}) {
    const id=text(workId,'workId'); const record=await store.get(`work:${id}`); if(!record) throw new Error('WORK_NOT_FOUND'); if(record.state===WORK_STATE.COMPLETED) return clone(record); if(record.state===WORK_STATE.CANCELLED) throw new Error('WORK_CANCELLED');
    const now=clock(); const next={...record,state:WORK_STATE.COMPLETED,online:{...(record.online||{}),status:'OFFLINE',closure:'COMPLETE',closedAt:now,closedBy:'MIMIR'},
      workPass:completeWorkPass(record.workPass,{completedAt:now,completedBy:'MIMIR'}),completion:{actor:'MIMIR',requestedBy:requestedBy||actor,completedAt:now},history:[...(record.history||[]),{state:WORK_STATE.COMPLETED,actor:'MIMIR',at:now}],updatedAt:now};
    await store.put(`work:${id}`,next); return clone(next);
  }

  const reception = createHermesIntakeDesk({
    store,
    tabletRuntime,
    createWork: intake,
    getWork,
    listWorks,
    resumeWork,
    clock,
    idFactory,
  });

  async function health() { return { service: 'metropolis', status: 'READY', sourceSha, components: Object.fromEntries(CITY_COMPONENTS.map((component) => [component, { status: 'READY' }])), mailboxCount: [...mailboxes.values()].filter((mailbox) => mailbox.status === MAILBOX_STATUS.OPEN).length, observedAt: clock() }; }

  return Object.freeze({ intake, resumeWork, handoff, returnWork, cancelWork, completeWork, registerMailbox, sendCargo, getWork, listWorks, reception, health, map: createCityMap() });
}
