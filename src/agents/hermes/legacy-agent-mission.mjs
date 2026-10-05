import { createMissionCard, missionTicketSearchCode } from "./go-hub-mission-card.mjs";
import { workCardView } from "./go-hub-work-card.js";
import { CARD_HISTORY_RESET, currentCardHistoryPins, cardHistoryPolicyView } from "./go-hub-card-history-policy.mjs";
import { translateAgentAction } from "./go-hub-agent-family-runtime.mjs";
import { createInterruptionRecovery, normalizeWorkLineage } from "./go-hub-master-architecture.mjs";

const text = value => String(value ?? "").trim();
const clone = value => value == null ? value : structuredClone(value);
const unique = values => [...new Set((values || []).map(text).filter(Boolean))];
const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
  status,
  headers:{ "content-type":"application/json; charset=utf-8" },
});

function missionReturnLifecycle(missionStatus) {
  const normalized = text(missionStatus).toUpperCase();
  const translated = translateAgentAction({
    agentId:"HERMES",
    action:"return_tablet",
    sourceEvent:"HERMES_MISSION_RETURN",
  });
  const workStatus = {
    "ON PROCESS":"RETURNED",
    WAIT:"WAIT",
    "WAIT VERIFY":"WAIT_VERIFY",
    BLOCKED:"BLOCKED",
    UNKNOWN:"UNKNOWN",
    COMPLETE:"WAIT_VERIFY",
    CANCEL:"CANCELLED",
  }[normalized] || "RETURNED";
  return Object.freeze({
    ...translated,
    workStatus,
    nextEvent:normalized === "CANCEL" ? null : "VERIFY",
    closeAllowed:false,
  });
}

async function payload(response) {
  if (response instanceof Response) return response.clone().json().catch(() => ({}));
  return clone(response || {});
}

function okResponse(value) {
  return value instanceof Response ? value.ok : value?.ok !== false;
}

function thaiText(value) {
  return text(value).toLocaleLowerCase("th-TH");
}

function compact(value) {
  return thaiText(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function grams(value, size = 2) {
  const source = compact(value);
  if (!source) return [];
  if (source.length <= size) return [source];
  const out = [];
  for (let i = 0; i <= source.length - size; i += 1) out.push(source.slice(i, i + size));
  return [...new Set(out)];
}

function tokens(value) {
  return [...new Set(thaiText(value).split(/[^\p{L}\p{N}]+/u).map(x => x.trim()).filter(Boolean))];
}

function jaccard(a = [], b = []) {
  const left = new Set(a), right = new Set(b);
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let same = 0;
  for (const item of left) if (right.has(item)) same += 1;
  return same / (left.size + right.size - same);
}

function candidateText(pin = {}) {
  const card = pin.card || {};
  return [
    pin.title,
    pin.detail,
    pin.workId,
    pin.jobCode,
    pin.repository,
    pin.projectRefs?.repository,
    card.title,
    card.detail,
    card.repository,
    card.projectRefs?.repository,
  ].filter(Boolean).join(" ");
}

function exactMissionReference(mission) {
  const workId = text(mission).match(/\bWORK-[A-Z0-9]+(?:-[A-Z0-9]+)+\b/i)?.[0];
  if (workId) return { type:"WORK_ID", value:workId.toUpperCase() };
  const repository = text(mission).match(/\b(?:https?:\/\/github\.com\/)?([A-Z0-9_.-]+\/[A-Z0-9_.-]+)(?:\.git)?\b/i)?.[1];
  if (!repository || /\.(?:mjs|cjs|js|json|md|ts|tsx|jsx)$/i.test(repository)) return null;
  return { type:"REPOSITORY", value:repository.toLowerCase().replace(/\.git$/, "") };
}

function namedSubject(mission) {
  const first = text(mission).match(/^[A-Z][A-Z0-9_-]{3,}\b/)?.[0];
  return first && !["HERMES","FACTORY","WORK","REVIEW","INSPECT","UPDATE","CREATE"].includes(first) ? first.toLowerCase() : null;
}

function statusBoost(pin = {}) {
  const status = text(pin.card?.sourceStatus || pin.status).toUpperCase();
  if (["ON PROCESS","DOING"].includes(status)) return 0.10;
  if (["OPEN","READY","ARRIVED"].includes(status)) return 0.06;
  if (["WAIT","WAIT CONFIRM","VERIFY"].includes(status)) return 0.05;
  if (["COMPLETE","RETURNED","ARCHIVED"].includes(status)) return -0.03;
  if (["CANCEL","CANCELLED"].includes(status)) return -0.10;
  return 0;
}

export function missionSimilarity(mission, pin) {
  const source = candidateText(pin);
  const lexical =
    jaccard(tokens(mission), tokens(source)) * 0.30 +
    jaccard(grams(mission, 2), grams(source, 2)) * 0.40 +
    jaccard(grams(mission, 3), grams(source, 3)) * 0.30;
  if (!lexical) return 0;
  return Math.max(0, Math.min(1, lexical + statusBoost(pin)));
}

export function rankMissionCandidates(mission, pins = [], { limit = 6, threshold = 0.20 } = {}) {
  const exact = exactMissionReference(mission);
  const subject = exact ? null : namedSubject(mission);
  return (Array.isArray(pins) ? pins : [])
    .filter(pin => exact ? (exact.type === "WORK_ID"
      ? text(pin.workId).toUpperCase() === exact.value
      : candidateText(pin).toLowerCase().includes(exact.value))
      : !subject || tokens(candidateText(pin)).includes(subject))
    .map(pin => ({ pin, score:exact ? 1 : missionSimilarity(mission, pin) }))
    .filter(item => exact || item.score >= Math.max(0.24, Number(threshold) || 0))
    .sort((a,b) => b.score - a.score || String(b.pin.updatedAt || "").localeCompare(String(a.pin.updatedAt || "")))
    .slice(0, Math.max(1, Math.min(Number(limit) || 6, 20)))
    .map(({ pin, score }) => Object.freeze({
      workId:text(pin.workId),
      checkpointId:text(pin.card?.checkpointId || pin.checkpointId) || null,
      cardId:text(pin.card?.cardId) || null,
      jobCode:text(pin.card?.jobCode || pin.jobCode) || null,
      title:text(pin.card?.title || pin.title) || null,
      detail:text(pin.card?.detail || pin.detail) || null,
      status:text(pin.card?.sourceStatus || pin.status) || null,
      snapshotKey:text(pin.card?.snapshot_key || pin.snapshotKey) || null,
      toolAccess:unique(pin.card?.tool_access || pin.toolAccess),
      score:Number(score.toFixed(4)),
      source:exact?.type || "HEIMDALL_PROJECT_INDEX",
    }));
}

function bangkokDateStamp(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Asia/Bangkok", year:"numeric", month:"2-digit", day:"2-digit",
  }).formatToParts(date);
  const pick = type => parts.find(part => part.type === type)?.value || "";
  return `${pick("year")}${pick("month")}${pick("day")}`;
}

function canonicalWorkKey(value) {
  const normalized = text(value)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
    .toUpperCase();
  return normalized.slice(0, 56) || "MISSION";
}

function nextCanonicalWorkId({ mission, workKey, pins = [], at }) {
  const date = bangkokDateStamp(at);
  const key = canonicalWorkKey(workKey || mission);
  const prefix = `WORK-${key}-${date}-`;
  let max = 0;
  for (const pin of Array.isArray(pins) ? pins : []) {
    const id = text(pin?.workId);
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length);
    if (/^\d{3}$/.test(suffix)) max = Math.max(max, Number(suffix));
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function requireWorkContext(input = {}) {
  const workId = text(input?.workContext?.workId || input.workId);
  const checkpointId = text(input?.workContext?.checkpointId || input.checkpointId);
  if (!workId || !checkpointId) throw Object.assign(new Error("HERMES_WORK_CONTEXT_REQUIRED"), { status:400 });
  return { workId, checkpointId };
}

function contextCandidate(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("HERMES_CONTEXT_CANDIDATE_INVALID"), { status:400 });
  }
  const contextId = text(value.contextId || value.id || `CTX-${index + 1}`);
  if (!contextId) throw Object.assign(new Error("HERMES_CONTEXT_ID_REQUIRED"), { status:400 });
  return {
    contextId,
    kind:text(value.kind || value.type || "CONTEXT").toUpperCase() || "CONTEXT",
    label:text(value.label || value.title) || null,
    summary:text(value.summary || value.detail) || null,
    target:text(value.target || value.value) || null,
    destination:text(value.destination) || null,
    tool:text(value.tool || value.toolName) || null,
    ref:text(value.ref || value.url) || null,
    refs:unique(value.refs),
    source:text(value.source) || null,
    observedAt:text(value.observedAt) || null,
  };
}

function choiceFitScore(query, candidate = {}) {
  const source = [
    candidate.label,
    candidate.summary,
    candidate.target,
    candidate.destination,
    candidate.tool,
    candidate.ref,
    ...(candidate.refs || []),
  ].filter(Boolean).join(" ");
  const lexical =
    jaccard(tokens(query), tokens(source)) * 0.35 +
    jaccard(grams(query, 2), grams(source, 2)) * 0.40 +
    jaccard(grams(query, 3), grams(source, 3)) * 0.25;
  return Number(Math.max(0, Math.min(1, lexical)).toFixed(4));
}

function evidenceRefs(evidence = []) {
  return (Array.isArray(evidence) ? evidence : [])
    .map(item => typeof item === "string" ? { ref:item } : clone(item))
    .filter(item => item && text(item.ref || item.evidenceRef || item.reference));
}

function workDestinationAllowed(work, destination) {
  const allowed = [
    ...(Array.isArray(work?.pass?.allowedDestinations) ? work.pass.allowedDestinations : []),
    ...(Array.isArray(work?.pass?.scope) ? work.pass.scope : []),
  ].map(text);
  return allowed.includes(destination) ||
    allowed.some(item => sameDestination(item, destination)) ||
    allowed.includes(destination.replace(/^destination:\/\//, "")) ||
    allowed.includes("ALL_GO_HUB_OWNED_AREAS");
}

function destinationKind(destination) {
  const value = text(destination).toLowerCase();
  if (!value) return null;
  if (value.startsWith("destination://")) return value.slice("destination://".length).split(/[/?#]/)[0] || null;
  if (value.startsWith("github://")) return "github";
  if (value.startsWith("drive://")) return "drive";
  if (value.startsWith("notion://")) return "notion";
  return value.includes("://") ? value.split("://")[0] : value;
}

function sameDestination(left, right) {
  const a = destinationKind(left);
  const b = destinationKind(right);
  return Boolean(a && b && a === b);
}

const DEFAULT_DESTINATION_TOOL_ACCESS = Object.freeze({
  github:Object.freeze([
    "go_hub_inspect_repository",
    "go_hub_read_file",
    "go_hub_create_branch",
    "go_hub_put_file",
    "go_hub_compare_refs",
    "go_hub_open_pull_request",
    "go_hub_get_pull_request",
    "go_hub_get_ci",
    "go_hub_get_failure_evidence",
    "go_hub_rerun_failed_jobs",
    "go_hub_get_workflow_runs",
  ]),
  factory:Object.freeze(["go_hub_factory_v4"]),
  drive:Object.freeze(["go_hub_drive_capabilities"]),
  counter:Object.freeze(["go_hub_counter_create"]),
  lighthouse:Object.freeze(["go_hub_lighthouse_control_port_state"]),
  maintenance:Object.freeze(["go_hub_maintenance"]),
});

function destinationTools(destination) {
  return [...(DEFAULT_DESTINATION_TOOL_ACCESS[destinationKind(destination)] || [])];
}

function routeDoor(work = {}, destination, currentCard = null) {
  const pass = work?.pass || {};
  const cardDestinations = unique(currentCard?.destinations);
  const active = text(pass.state).toUpperCase() === "ACTIVE" && workDestinationAllowed(work, destination);
  return {
    destination:text(destination),
    kind:destinationKind(destination) || "unknown",
    declared:true,
    cardListed:cardDestinations.some(item => sameDestination(item, destination)),
    active,
    authority:text(currentCard?.access_scope || work?.accessScope || pass.kind).toUpperCase() || "UNKNOWN",
    returnAddress:text(pass.returnAddress || work?.checkpointId) || null,
    returnCondition:text(pass.closeCondition) || "RETURN",
    reason:active ? (text(pass.reason) || "ACTIVE_WORK_PASS") : "WORK_REQUESTED_DESTINATION",
  };
}

function resumeView(work = {}) {
  const status = text(work.status).toUpperCase();
  const holder = text(work.holder) || null;
  if (status === "OPEN") return { resumable:true, mode:"RETURNED_OPEN", holder:null, next:"FIRST_OPEN_CURRENT_ROUTE" };
  if (status === "WAIT CONFIRM") return { resumable:true, mode:"WAIT_CONFIRM", holder, next:"FIRST_OPEN_CURRENT_ROUTE" };
  if (status === "ON PROCESS" && holder === "GO") return { resumable:true, mode:"GO_ACTIVE", holder, next:"CONTINUE_CURRENT_ROUTE" };
  if (["COMPLETE","CANCEL"].includes(status)) return { resumable:false, mode:"TERMINAL", holder:null, next:null };
  return { resumable:false, mode:"UNKNOWN", holder, next:null };
}

function missionManualControls(work = {}, mission = null) {
  const status = text(work.status).toUpperCase();
  const holder = text(work.holder) || null;
  const sessionStatus = text(mission?.session?.status).toUpperCase() || null;
  const passActive = text(work?.pass?.state).toUpperCase() === "ACTIVE";
  return [
    {
      id:"MANUAL_CONTINUE",
      label:"ไปต่อเอง",
      action:"manual_continue",
      enabled:status !== "CANCEL",
      kind:"MANUAL",
      reason:status === "CANCEL" ? "CANCEL_WORK_REQUIRES_NEW_DECISION" : "OWNER_EXPLICIT_CONTINUE",
    },
    {
      id:"EMERGENCY_ENTER",
      label:"ฉุกเฉิน: เข้า",
      action:"emergency_enter",
      enabled:status !== "CANCEL",
      kind:"EMERGENCY",
      reason:"OWNER_OVERRIDE_ENTER_WITHOUT_OPENING_DESTINATION",
    },
    {
      id:"EMERGENCY_EXIT",
      label:"ฉุกเฉิน: ออก",
      action:"emergency_exit",
      enabled:Boolean((sessionStatus && sessionStatus !== "EXITED") || holder || passActive),
      kind:"EMERGENCY",
      reason:"OWNER_OVERRIDE_RETURN_TO_SAFE_CENTRE_STATE",
    },
  ];
}

function fallbackManualControls() {
  return [
    { id:"MANUAL_CONTINUE", label:"ไปต่อเอง", action:"manual_continue", kind:"MANUAL" },
    { id:"EMERGENCY_ENTER", label:"ฉุกเฉิน: เข้า", action:"emergency_enter", kind:"EMERGENCY" },
    { id:"EMERGENCY_EXIT", label:"ฉุกเฉิน: ออก", action:"emergency_exit", kind:"EMERGENCY" },
  ];
}

function composeMissionReadout(work = {}, mission = null) {
  const memory = mission?.memory || {};
  const currentCard = memory.cardMachine?.current || null;
  const route = unique(work.requestedDestinations);
  const latest = memory.latestReality || null;
  return {
    kind:"HERMES_MISSION_READOUT",
    mode:"READ_ONLY",
    identity:{
      agentId:text(mission?.session?.agentId) || null,
      sessionStatus:text(mission?.session?.status) || null,
    },
    activeIntent:text(memory.mission || work.command || work.name) || null,
    requestedResult:text(memory.requestedResult || work.expectedResult) || null,
    work:{
      workId:text(work.workId) || null,
      checkpointId:text(work.checkpointId) || null,
      sourceStatus:text(work.status) || null,
      holder:text(work.holder) || null,
      ownerSource:"CENTRE_DURABLE_STORE",
    },
    currentRoute:route,
    warpDoors:route.map(destination => routeDoor(work, destination, currentCard)),
    access:{
      accessScope:text(currentCard?.access_scope || work.accessScope).toUpperCase() || null,
      passKind:text(work.pass?.kind).toUpperCase() || null,
      passState:text(work.pass?.state).toUpperCase() || null,
    },
    resume:resumeView(work),
    nextAction:text(latest?.nextAction) || null,
    unknowns:unique(latest?.unknowns),
    lastLocation:text(latest?.lastLocation || mission?.session?.lastDestination) || null,
    observedFrom:["CENTRE_WORK","HERMES_MISSION_MEMORY","CURRENT_CARD"],
    manualControls:missionManualControls(work, mission),
  };
}

function lightCandidates(lightResult = {}) {
  const candidates = [];
  let n = 0;
  for (const ref of unique(lightResult.sources)) {
    candidates.push({ contextId:`LIGHT-SOURCE-${++n}`, ref, source:"LIGHT", summary:null });
  }
  for (const item of Array.isArray(lightResult.evidence) ? lightResult.evidence : []) {
    const ref = text(item?.ref || item?.reference || item?.evidenceRef);
    if (!ref) continue;
    candidates.push({
      contextId:`LIGHT-EVIDENCE-${++n}`,
      ref,
      source:"LIGHT",
      summary:text(item?.summary || item?.kind) || null,
    });
  }
  return candidates;
}

export function createAgentMissionService({
  centreLive,
  counterDispatch,
  boardRead,
  now = () => new Date().toISOString(),
  createId = prefix => `${prefix}-${crypto.randomUUID()}`,
} = {}) {
  if (!centreLive || typeof centreLive.action !== "function") throw new Error("HERMES_CENTRE_REQUIRED");
  if (!counterDispatch || typeof counterDispatch.create !== "function") throw new Error("HERMES_COUNTER_REQUIRED");
  if (typeof boardRead !== "function") throw new Error("HERMES_HEIMDALL_INDEX_REQUIRED");

  async function centre(input) {
    const response = await centreLive.action(input);
    const body = await payload(response);
    if (!okResponse(response)) {
      const error = Object.assign(new Error(body?.code || "HERMES_CENTRE_ACTION_FAILED"), { status:response?.status || 500, body });
      throw error;
    }
    return body;
  }

  async function readMission(workContext) {
    return centre({ action:"v4_mission_get", ...workContext });
  }

  function recoveryDetails(input = {}, resolved = {}, mode = "INTERRUPTED") {
    const ticket = resolved.current?.mission?.memory?.cardMachine?.current || resolved.card || {};
    const reality = resolved.current?.mission?.memory?.latestReality || {};
    const observedAt = text(input.observedAt || input.timestamp || now()) || null;
    const evidence = input.evidence === undefined ? (ticket.evidence || reality.evidence || []) : input.evidence;
    const unknownGap = input.unknownGap !== undefined
      ? input.unknownGap
      : input.unknowns !== undefined ? input.unknowns : (reality.unknownGap || reality.unknowns || []);
    return createInterruptionRecovery({
      workId:resolved.workContext?.workId || resolved.work?.workId,
      checkpointId:resolved.workContext?.checkpointId || resolved.work?.checkpointId,
      actor:text(input.actor || resolved.current?.mission?.session?.agentId || ticket.agentId || "GO").toUpperCase(),
      lastSafePoint:text(input.lastSafePoint || input.safePoint || input.lastLocation || ticket.lastSafePoint || reality.lastKnownState) || null,
      lastAction:text(input.lastAction || ticket.lastAction) || null,
      lastLocation:text(input.lastLocation || ticket.lastLocation || reality.lastLocation) || null,
      observedAt,
      evidenceRefs:evidenceRefs(evidence),
      receipt:clone(input.receipt || reality.receipt || null),
      repo:text(input.repo || input.repository || reality.repo || reality.repository) || null,
      pr:text(input.pr || input.pullRequest || reality.pr || reality.pullRequest) || null,
      sha:text(input.sha || input.commitSha || reality.sha || reality.commitSha) || null,
      unknownGap:unique(unknownGap),
      interruptCause:text(input.interruptCause || input.cause || reality.interruptCause || reality.cause) || null,
      mode:text(input.recoveryMode || input.mode || mode).toUpperCase(),
    });
  }

  async function inspectWork(workContext) {
    const view = await centre({ action:"v4_inspect", workId:workContext.workId, checkpointId:workContext.checkpointId });
    if (!view?.work || text(view.work.checkpointId) !== workContext.checkpointId) {
      throw Object.assign(new Error("HERMES_WORK_IDENTITY_MISMATCH"), { status:409 });
    }
    return view.work;
  }

  async function reconcileCandidate(candidate) {
    if (!candidate?.workId) return { ...candidate, checkpointStatus:"UNKNOWN", checkpointDrift:false };
    try {
      const inspected = await centre({ action:"v4_inspect", workId:candidate.workId });
      const ownerCheckpoint = text(inspected?.work?.checkpointId);
      if (!ownerCheckpoint) return { ...candidate, checkpointId:null, checkpointStatus:"UNKNOWN", checkpointDrift:false };
      const indexedCheckpoint = text(candidate.checkpointId);
      return {
        ...candidate,
        checkpointId:ownerCheckpoint,
        checkpointStatus:indexedCheckpoint === ownerCheckpoint ? "OWNER_VERIFIED" : "OWNER_CORRECTED",
        checkpointDrift:Boolean(indexedCheckpoint && indexedCheckpoint !== ownerCheckpoint),
      };
    } catch {
      return { ...candidate, checkpointId:null, checkpointStatus:"UNKNOWN", checkpointDrift:false };
    }
  }

  async function resolveCardContext(input = {}) {
    const requestedCardId = text(input.cardId);
    if (!requestedCardId) {
      throw Object.assign(new Error("HERMES_CARD_ID_REQUIRED"), { status:400 });
    }
    const raw = await boardRead();
    const board = await payload(raw);
    if (!okResponse(raw) || !Array.isArray(board?.pins)) {
      throw Object.assign(new Error("HERMES_CARD_INDEX_UNAVAILABLE"), { status:503 });
    }
    const wanted = requestedCardId.toUpperCase();
    const matches = board.pins.filter(pin =>
      text(pin?.card?.cardId || (pin?.jobCode ? "CARD:" + pin.jobCode : "")).toUpperCase() === wanted
    );
    if (!matches.length) throw Object.assign(new Error("HERMES_CARD_NOT_FOUND"), { status:404 });
    if (matches.length > 1) throw Object.assign(new Error("HERMES_CARD_ID_AMBIGUOUS"), { status:409 });
    const pin = matches[0];
    const reconciled = await reconcileCandidate({
      workId:text(pin.workId),
      checkpointId:text(pin.card?.checkpointId || pin.checkpointId) || null,
      cardId:text(pin.card?.cardId) || requestedCardId,
      jobCode:text(pin.card?.jobCode || pin.jobCode) || null,
      title:text(pin.card?.title || pin.title) || null,
      detail:text(pin.card?.detail || pin.detail) || null,
      status:text(pin.card?.sourceStatus || pin.status) || null,
      snapshotKey:text(pin.card?.snapshot_key || pin.snapshotKey) || null,
      toolAccess:unique(pin.card?.tool_access || pin.toolAccess),
      score:1,
      source:"CARD_ID",
    });
    if (!reconciled.workId || !reconciled.checkpointId) {
      throw Object.assign(new Error("HERMES_CARD_OWNER_CONTEXT_UNKNOWN"), { status:409 });
    }
    const workContext = { workId:reconciled.workId, checkpointId:reconciled.checkpointId };
    const current = await readMission(workContext);
    const work = current.work || await inspectWork(workContext);
    const currentCard = current.mission?.memory?.cardMachine?.current || null;
    const ownerCardId = text(currentCard?.cardId || workCardView(work).cardId);
    if (ownerCardId && ownerCardId.toUpperCase() !== wanted) {
      throw Object.assign(new Error("HERMES_CARD_OWNER_ID_MISMATCH"), { status:409 });
    }
    return {
      cardId:ownerCardId || requestedCardId,
      workContext,
      current,
      work,
      card:currentCard || workCardView(work),
    };
  }

  async function ensurePickupState(resolved) {
    let current = resolved.current;
    let work = resolved.work;
    const terminal = new Set(["COMPLETE","CANCEL"]);
    if (terminal.has(text(work.status).toUpperCase())) {
      return { ...resolved, current, work, terminal:true };
    }

    let sessionStatus = text(current.mission?.session?.status).toUpperCase();
    if (sessionStatus === "RETURNED") {
      await centre({ action:"v4_mission_exit", ...resolved.workContext });
      current = await readMission(resolved.workContext);
      sessionStatus = text(current.mission?.session?.status).toUpperCase();
    }
    if (!sessionStatus || sessionStatus === "EXITED") {
      const entered = await centre({
        action:"v4_mission_enter",
        ...resolved.workContext,
        sessionId:createId("HERMES-CARD"),
        agentId:"GO",
        mission:text(current.mission?.memory?.mission || work.command || work.name),
        requestedResult:text(current.mission?.memory?.requestedResult || work.expectedResult) || null,
      });
      current = { ...current, mission:entered.mission };
    }

    const status = text(work.status).toUpperCase();
    if (status === "OPEN") {
      work = (await centre({ action:"v4_claim", ...resolved.workContext, actor:"GO" })).work;
    } else if (status === "WAIT CONFIRM") {
      work = (await centre({ action:"v4_resume", ...resolved.workContext, actor:"GO" })).work;
    } else if (status === "ON PROCESS" && text(work.holder) && text(work.holder) !== "GO") {
      throw Object.assign(new Error("HERMES_CARD_HELD_BY_OTHER_AGENT"), { status:409 });
    }

    current = await readMission(resolved.workContext);
    work = current.work || work;
    return {
      ...resolved,
      current,
      work,
      card:current.mission?.memory?.cardMachine?.current || resolved.card || workCardView(work),
      terminal:false,
    };
  }

  function cardPacket(resolved) {
    const mission = resolved.current?.mission || {};
    const memory = mission.memory || {};
    const card = memory.cardMachine?.current || resolved.card || workCardView(resolved.work);
    return {
      cardId:text(card?.cardId || resolved.cardId) || null,
      card:clone(card),
      workContext:clone(resolved.workContext),
      intent:clone(card?.intent || {
        mission:text(memory.mission || resolved.work?.command || resolved.work?.name) || null,
        requestedResult:text(memory.requestedResult || resolved.work?.expectedResult) || null,
      }),
      selectedContext:clone(card?.context || memory.selectedContext || []),
      lastReturn:clone(card?.last_return || memory.latestReality || null),
      ownerReadback:{
        source:"CENTRE_DURABLE_STORE",
        sourceStatus:text(resolved.work?.status) || null,
        holder:text(resolved.work?.holder) || null,
        lastUpdated:text(resolved.work?.lastUpdated) || null,
      },
      directToolAccess:unique(card?.tool_access || resolved.work?.toolAccess),
      destinations:unique(card?.destinations || resolved.work?.requestedDestinations),
      authority:{
        mode:"CARD_TOOL_ACCESS",
        hermesMediatesToolCalls:false,
        firstOpenRequired:false,
        passRequiredByHermes:false,
      },
    };
  }

  async function find(input = {}) {
    const mission = text(input.mission);
    if (!mission) return json({ code:"HERMES_MISSION_REQUIRED" }, 400);
    const raw = await boardRead();
    const board = await payload(raw);
    if (!okResponse(raw) || !Array.isArray(board?.pins)) {
      return json({ code:"HERMES_HEIMDALL_INDEX_UNAVAILABLE" }, 503);
    }
    const exactSnapshot = /^SNAP-\d{8}-[A-Z0-9]{6}$/i.test(mission)
      ? board.pins.filter(pin => text(pin.card?.snapshot_key || pin.snapshotKey).toUpperCase() === mission.toUpperCase())
      : [];
    const currentPins = currentCardHistoryPins(board.pins, CARD_HISTORY_RESET);
    const indexedCandidates = exactSnapshot.length
      ? exactSnapshot.map(pin => ({ workId:text(pin.workId), checkpointId:text(pin.card?.checkpointId || pin.checkpointId) || null, cardId:text(pin.card?.cardId)||null, jobCode:text(pin.card?.jobCode||pin.jobCode)||null, title:text(pin.card?.title||pin.title)||null, detail:text(pin.card?.detail||pin.detail)||null, status:text(pin.card?.sourceStatus||pin.status)||null, snapshotKey:mission.toUpperCase(), toolAccess:unique(pin.card?.tool_access||pin.toolAccess), score:1, source:"SNAPSHOT_KEY" }))
      : rankMissionCandidates(mission, currentPins, { limit:input.limit, threshold:input.threshold });
    const candidates = await Promise.all(indexedCandidates.map(reconcileCandidate));
    return json({
      ok:true,
      action:"find",
      mission,
      candidates,
      recommendedTools:unique(candidates.flatMap(item => item.toolAccess || [])),
      source:exactSnapshot.length ? "SNAPSHOT_KEY" : exactMissionReference(mission)?.type || "HEIMDALL_PROJECT_INDEX_CURRENT_EPOCH",
      historyPolicy:cardHistoryPolicyView(CARD_HISTORY_RESET),
      noMatch:candidates.length === 0,
      boardExposed:false,
    });
  }

  async function resolveEntryWork(input = {}) {
    const suppliedWorkId = text(input?.workContext?.workId || input.workId);
    const suppliedCheckpointId = text(input?.workContext?.checkpointId || input.checkpointId);

    if (suppliedWorkId) {
      const inspected = await centre({ action:"v4_inspect", workId:suppliedWorkId });
      const ownerCheckpointId = text(inspected?.work?.checkpointId);
      if (!ownerCheckpointId) {
        throw Object.assign(new Error("HERMES_WORK_OWNER_CONTEXT_UNKNOWN"), { status:409 });
      }
      if (suppliedCheckpointId && suppliedCheckpointId !== ownerCheckpointId) {
        throw Object.assign(new Error("HERMES_WORK_IDENTITY_MISMATCH"), { status:409 });
      }
      return {
        mode:"SUPPLIED_WORK_ID",
        workContext:{ workId:suppliedWorkId, checkpointId:ownerCheckpointId },
        work:inspected.work,
      };
    }

    const mission = text(input.mission);
    if (!mission) {
      return { mode:"ASK_WORK_ID", workContext:null, work:null };
    }

    const foundResponse = await find({ ...input, action:"find", mission });
    const found = await payload(foundResponse);
    if (!okResponse(foundResponse)) {
      throw Object.assign(new Error(found?.code || "HERMES_WORK_SEARCH_FAILED"), {
        status:foundResponse?.status || 500,
        body:found,
      });
    }

    if (found.candidates?.length) {
      const candidate = found.candidates[0];
      if (!candidate.workId || !candidate.checkpointId) {
        throw Object.assign(new Error("HERMES_WORK_OWNER_CONTEXT_UNKNOWN"), { status:409 });
      }
      return {
        mode:"REUSED_EXISTING_WORK",
        workContext:{ workId:candidate.workId, checkpointId:candidate.checkpointId },
        work:await inspectWork({ workId:candidate.workId, checkpointId:candidate.checkpointId }),
        candidate,
      };
    }

    const requestedResult = text(input.requestedResult);
    if (!requestedResult) {
      return {
        mode:"ASK_REQUESTED_RESULT_FOR_NEW_WORK",
        workContext:null,
        work:null,
        searched:true,
        noMatch:true,
      };
    }

    const createdResponse = await create({
      ...input,
      action:"create",
      workId:undefined,
      workContext:undefined,
      createDecision:"CREATE_NEW",
    });
    const created = await payload(createdResponse);
    if (!okResponse(createdResponse)) {
      throw Object.assign(new Error(created?.code || "HERMES_WORK_CREATE_FAILED"), {
        status:createdResponse?.status || 500,
        body:created,
      });
    }
    return {
      mode:"CREATED_NEW_WORK",
      workContext:created.workContext,
      work:created.card ? await inspectWork(created.workContext) : null,
      created,
    };
  }

  async function enter(input = {}) {
    const resolved = await resolveEntryWork(input);
    if (!resolved.workContext) {
      return json({
        ok:true,
        action:"enter",
        entered:true,
        workContext:null,
        workSelected:false,
        noGate:true,
        authorityCreated:false,
        routeSelected:false,
        resolution:resolved.mode,
        nextActions:resolved.mode === "ASK_WORK_ID"
          ? ["supply_work_id","enter_with_mission"]
          : ["supply_requested_result"],
        prompt:resolved.mode === "ASK_WORK_ID"
          ? "มี Work ID ไหม? ถ้ามีส่ง Work ID มาได้เลย; ถ้าไม่มี ส่ง mission มาแล้ว HERMES จะค้น Work เดิมหนึ่งครั้ง และสร้างใหม่เมื่อไม่พบ"
          : "ไม่พบ Work เดิม กรุณาระบุ Requested Result เพื่อสร้าง Work ใหม่แล้วไปต่อ",
      });
    }

    const workContext = resolved.workContext;
    let work = resolved.work || await inspectWork(workContext);
    const current = await readMission(workContext);
    const sessionStatus = text(current.mission?.session?.status).toUpperCase();
    let mission = current.mission;

    if (!sessionStatus || sessionStatus === "EXITED") {
      const response = await centre({
        action:"v4_mission_enter",
        ...workContext,
        sessionId:text(input.sessionId) || createId("HERMES-SESSION"),
        agentId:text(input.agentId) || "GO",
        mission:text(input.mission) || work.command || work.name,
        requestedResult:text(input.requestedResult) || work.expectedResult || null,
      });
      mission = response.mission;
    }

    return json({
      ok:true,
      action:"enter",
      entered:true,
      card:workCardView(work),
      workContext,
      mission,
      readout:composeMissionReadout(work, mission),
      noGate:true,
      workSelected:true,
      resolution:resolved.mode,
      reused:resolved.mode === "REUSED_EXISTING_WORK" || resolved.mode === "SUPPLIED_WORK_ID",
      created:resolved.mode === "CREATED_NEW_WORK",
    }, resolved.mode === "CREATED_NEW_WORK" ? 201 : 200);
  }

  async function reopen(input = {}) {
    const workContext = requireWorkContext(input);
    let current = await readMission(workContext);
    let work = current.work || await inspectWork(workContext);
    if (text(work.status).toUpperCase() !== "COMPLETE") {
      return json({
        code:"HERMES_COMPLETE_WORK_REQUIRED",
        action:"reopen",
        workContext,
        readout:composeMissionReadout(work, current.mission),
      }, 409);
    }

    const sessionStatus = text(current.mission?.session?.status).toUpperCase();
    if (sessionStatus === "RETURNED") {
      await centre({ action:"v4_mission_exit", ...workContext });
      current = await readMission(workContext);
    } else if (sessionStatus && sessionStatus !== "EXITED") {
      return json({
        code:"HERMES_ACTIVE_SESSION_MUST_RETURN_OR_EXIT",
        action:"reopen",
        workContext,
        readout:composeMissionReadout(work, current.mission),
      }, 409);
    }

    const reopened = await centre({ action:"v4_reopen", ...workContext, actor:"GO" });
    work = reopened.work;
    const memory = current.mission?.memory || {};
    const entered = await centre({
      action:"v4_mission_enter",
      ...workContext,
      sessionId:text(input.sessionId) || createId("HERMES-SESSION"),
      agentId:text(input.agentId) || "GO",
      mission:text(input.mission) || memory.mission || work.command || work.name,
      requestedResult:text(input.requestedResult) || memory.requestedResult || work.expectedResult || null,
    });
    return json({
      ok:true,
      action:"reopen",
      reopened:true,
      sameWork:true,
      workContext,
      card:workCardView(work),
      mission:entered.mission,
      readout:composeMissionReadout(work, entered.mission),
      prompt:"เปิด Work เดิมกลับมาทำต่อแล้วครับ ใช้ Work ID / Checkpoint เดิม",
    });
  }

  async function manualContinue(input = {}) {
    const workContext = requireWorkContext(input);
    let current = await readMission(workContext);
    let work = current.work || await inspectWork(workContext);
    const status = text(work.status).toUpperCase();
    if (status === "CANCEL") {
      return json({
        code:"HERMES_CANCEL_WORK_CANNOT_CONTINUE",
        action:"manual_continue",
        workContext,
        readout:composeMissionReadout(work, current.mission),
      }, 409);
    }

    const sessionStatus = text(current.mission?.session?.status).toUpperCase();
    if (status === "COMPLETE" && sessionStatus && sessionStatus !== "EXITED") {
      await centre({ action:"v4_mission_emergency_exit", ...workContext });
      current = await readMission(workContext);
    } else if (sessionStatus === "RETURNED") {
      await centre({ action:"v4_mission_exit", ...workContext });
      current = await readMission(workContext);
    }

    if (status === "COMPLETE") {
      work = (await centre({ action:"v4_reopen", ...workContext, actor:"GO" })).work;
    } else if (status === "OPEN") {
      work = (await centre({ action:"v4_claim", ...workContext, actor:"GO" })).work;
    } else if (status === "WAIT CONFIRM") {
      work = (await centre({ action:"v4_resume", ...workContext, actor:"GO" })).work;
    } else if (status === "ON PROCESS") {
      if (text(work.holder) && text(work.holder) !== "GO") {
        return json({
          code:"HERMES_WORK_HELD_BY_OTHER_AGENT",
          action:"manual_continue",
          workContext,
          holder:text(work.holder),
          readout:composeMissionReadout(work, current.mission),
        }, 409);
      }
    }

    current = await readMission(workContext);
    const activeStatus = text(current.mission?.session?.status).toUpperCase();
    let mission = current.mission;
    if (!activeStatus || activeStatus === "EXITED") {
      const entered = await centre({
        action:"v4_mission_enter",
        ...workContext,
        sessionId:text(input.sessionId) || createId("HERMES-SESSION"),
        agentId:"GO",
        mission:text(input.mission) || current.mission?.memory?.mission || work.command || work.name,
        requestedResult:text(input.requestedResult) || current.mission?.memory?.requestedResult || work.expectedResult || null,
      });
      mission = entered.mission;
    }

    return json({
      ok:true,
      action:"manual_continue",
      continued:true,
      explicitOwnerAction:true,
      workContext,
      card:workCardView(work),
      mission,
      readout:composeMissionReadout(work, mission),
      prompt:"GO กดไปต่อเองแล้วครับ HERMES จัด lifecycle ให้ แต่ยังไม่เปิด Destination หรือเพิ่ม Authority",
    });
  }

  async function emergencyEnter(input = {}) {
    const workContext = requireWorkContext(input);
    const current = await readMission(workContext);
    const work = current.work || await inspectWork(workContext);
    if (text(work.status).toUpperCase() === "CANCEL") {
      return json({
        code:"HERMES_CANCEL_WORK_EMERGENCY_ENTER_BLOCKED",
        action:"emergency_enter",
        workContext,
        readout:composeMissionReadout(work, current.mission),
      }, 409);
    }

    const workResult = await centre({ action:"v4_emergency_enter", ...workContext });
    const entered = await centre({
      action:"v4_mission_emergency_enter",
      ...workContext,
      sessionId:text(input.sessionId) || createId("HERMES-SESSION"),
      agentId:"GO",
      mission:text(input.mission) || current.mission?.memory?.mission || workResult.work.command || workResult.work.name,
      requestedResult:text(input.requestedResult) || current.mission?.memory?.requestedResult || workResult.work.expectedResult || null,
    });
    return json({
      ok:true,
      action:"emergency_enter",
      emergency:true,
      explicitOwnerAction:true,
      destinationOpened:false,
      authorityExpanded:false,
      workContext,
      card:workCardView(workResult.work),
      mission:entered.mission,
      readout:composeMissionReadout(workResult.work, entered.mission),
      prompt:"เข้า HERMES แบบฉุกเฉินแล้วครับ ยังไม่ได้เปิด Destination หรือขยายสิทธิ์",
    });
  }

  async function emergencyExit(input = {}) {
    const workContext = requireWorkContext(input);
    const workResult = await centre({ action:"v4_emergency_exit", ...workContext });
    const exited = await centre({ action:"v4_mission_emergency_exit", ...workContext });
    return json({
      ok:true,
      action:"emergency_exit",
      emergency:true,
      explicitOwnerAction:true,
      workContext,
      card:workCardView(workResult.work),
      mission:exited.mission,
      readout:composeMissionReadout(workResult.work, exited.mission),
      exited:true,
      prompt:"ออกฉุกเฉินเรียบร้อยครับ Pass ปิด Holder ถูกปล่อย และกลับ Centre โดยไม่บังคับพิธี Return/Update/Exit ปกติ",
    });
  }

  async function create(input = {}) {
    const mission = text(input.mission);
    const requestedResult = text(input.requestedResult);
    if (!mission) return json({ code:"HERMES_MISSION_REQUIRED" }, 400);
    if (!requestedResult) return json({ code:"HERMES_REQUESTED_RESULT_REQUIRED" }, 400);
    const raw = await boardRead();
    const board = await payload(raw);
    if (!okResponse(raw) || !Array.isArray(board?.pins)) {
      return json({ code:"HERMES_HEIMDALL_INDEX_UNAVAILABLE" }, 503);
    }
    // Reuse search is explicit. GO calls find when it wants candidates; create never performs hidden similarity review.
    if (text(input.workId)) {
      return json({ code:"HERMES_WORK_ID_CALLER_OVERRIDE_FORBIDDEN" }, 400);
    }
    const workId = nextCanonicalWorkId({
      mission,
      workKey:input.workKey,
      pins:board.pins,
      at:now(),
    });
    const recommendedTools = unique(input.recommendedTools?.length
      ? input.recommendedTools
      : unique(input.destinations).flatMap(destinationTools));
    const creationAction = text(input.creationAction || "v4_create");
    const created = await centre({
      action:creationAction,
      ...(creationAction === "v4_create_derived" ? { sourceWorkId:text(input.sourceWorkId) } : {}),
      workId,
      work:{
        workId,
        name:mission,
        command:mission,
        expectedResult:requestedResult,
        requestedDestinations:unique(input.destinations),
        scope:unique(input.scope),
        workType:text(input.workType || "NORMAL").toUpperCase(),
        lineage:normalizeWorkLineage(input.lineage || {}),
      },
    });
    const work = created.work;
    const workContext = { workId:work.workId, checkpointId:work.checkpointId };
    const entered = await centre({
      action:"v4_mission_enter",
      ...workContext,
      sessionId:text(input.sessionId) || createId("HERMES-SESSION"),
      agentId:text(input.agentId) || "GO",
      mission,
      requestedResult,
    });
    const discoveredTools = recommendedTools;
    if (discoveredTools.length) {
      const remembered = await centre({ action:"v4_mission_recommended_tools", ...workContext, recommendedTools:discoveredTools });
      entered.mission = remembered.mission;
    }
    return json({
      ok:true,
      action:"create",
      created:true,
      card:workCardView(work),
      workContext,
      mission:entered.mission,
    }, 201);
  }

  function tabletIdFromTicket(ticket, fallback = null) {
    const explicit = text(ticket?.tabletId);
    if (explicit) return explicit;
    const jobCode = text(ticket?.jobCode);
    if (jobCode) return "TABLET:" + jobCode;
    const legacy = text(ticket?.cardId);
    if (/^CARD:/i.test(legacy)) return "TABLET:" + legacy.slice(5);
    return text(fallback) || null;
  }

  function legacyCardIdFromTabletId(tabletId) {
    const value = text(tabletId);
    if (!value) return null;
    return /^TABLET:/i.test(value) ? "CARD:" + value.slice(7) : value;
  }

  function tabletRecoveryView(ticket, reality = {}, current = null) {
    const sessionStatus = text(current?.mission?.session?.status).toUpperCase();
    const currentStatus = text(current?.work?.status).toUpperCase();
    const returnedStatus = text(reality.missionStatus).toUpperCase();
    const activeSession = Boolean(sessionStatus && !["RETURNED", "EXITED"].includes(sessionStatus));
    const status = (activeSession ? currentStatus : returnedStatus) || text(ticket?.status).toUpperCase() || currentStatus || "UNKNOWN";
    const hold = new Set(["WAIT", "WAIT VERIFY", "BLOCKED", "UNKNOWN"]).has(status);
    const recovery = ticket?.recovery || reality.recovery || {};
    const lastLocation = text(recovery.lastLocation || ticket?.lastLocation || reality.lastLocation) || null;
    const nextAction = text(ticket?.nextAction || reality.nextAction) || null;
    const unknowns = unique(ticket?.unknowns || reality.unknowns);
    const observedAt = text(recovery.observedAt || recovery.timestamp || ticket?.observedAt || reality.returnedAt || reality.observedAt || current?.work?.lastUpdated) || null;
    const lastSafePoint = text(recovery.lastSafePoint || recovery.safePoint || reality.lastKnownState || lastLocation) || null;
    return {
      mode:hold ? "HOLD" : ["COMPLETE", "CANCEL"].includes(status) ? "TERMINAL" : "ACTIVE",
      custody:hold ? "HERMES" : null,
      status,
      actor:text(recovery.actor || ticket?.agentId || current?.mission?.session?.agentId) || null,
      lastSafePoint,
      lastAction:text(recovery.lastAction) || null,
      lastLocation,
      nextAction,
      interruptCause:text(recovery.interruptCause || recovery.cause) || null,
      unknowns,
      unknownGap:unique(recovery.unknownGap || reality.unknownGap || unknowns),
      observedAt,
      timestamp:text(recovery.timestamp || observedAt) || null,
      evidenceRefs:clone(recovery.evidenceRefs || reality.evidence || []),
      receipt:clone(recovery.receipt || reality.receipt || null),
      repo:text(recovery.repo || reality.repo || reality.repository) || null,
      pr:text(recovery.pr || reality.pr || reality.pullRequest) || null,
      sha:text(recovery.sha || reality.sha || reality.commitSha) || null,
      safePoint:hold ? lastSafePoint : null,
      autoRetry:false,
      autoRollback:false,
      resumeAllowed:hold ? status !== "UNKNOWN" || Boolean(lastSafePoint || lastLocation || nextAction) : !["COMPLETE", "CANCEL"].includes(status),
    };
  }

  function tabletView(ticket, fallbackId = null, current = null) {
    if (!ticket) return null;
    const reality = ticket.last_return || current?.mission?.memory?.latestReality || {};
    const recovery = tabletRecoveryView(ticket, reality, current);
    return {
      kind:"HERMES_WORK_TABLET",
      version:Number(ticket.version || 1),
      tabletId:tabletIdFromTicket(ticket, fallbackId),
      agentId:text(ticket.agentId || current?.mission?.session?.agentId) || null,
      sessionId:text(ticket.sessionId || current?.mission?.session?.sessionId) || null,
      workId:text(ticket.workId) || null,
      checkpointId:text(ticket.checkpointId) || null,
      task:text(ticket.task || ticket.intent?.mission || current?.mission?.memory?.mission || current?.work?.command) || null,
      initialContext:clone(ticket.initialContext !== undefined ? ticket.initialContext : (ticket.context || current?.mission?.memory?.selectedContext || {})),
      status:text(ticket.status || reality.missionStatus || current?.work?.status) || null,
      lineage:clone(current?.work?.lineage || reality.lineage || null),
      result:clone(ticket.result !== undefined ? ticket.result : (reality.result ?? null)),
      evidence:clone(ticket.evidence !== undefined ? ticket.evidence : (reality.evidence || [])),
      lastLocation:text(ticket.lastLocation || reality.lastLocation) || null,
      nextAction:text(ticket.nextAction || reality.nextAction) || null,
      unknowns:unique(ticket.unknowns || reality.unknowns),
      recovery,
      readbackVerified:reality.readbackVerified === true || Boolean(reality.ownerReadback),
    };
  }

  async function resolveTabletContext(input = {}) {
    const suppliedTabletId = text(input.tabletId);
    const suppliedCardId = text(input.cardId);
    const suppliedId = suppliedTabletId || suppliedCardId;
    if (!suppliedId) throw Object.assign(new Error("HERMES_TABLET_ID_REQUIRED"), { status:400 });
    const legacyInput = !suppliedTabletId && Boolean(suppliedCardId);
    const resolved = await resolveCardContext({ ...input, cardId:legacyCardIdFromTabletId(suppliedId) });
    const tabletId = tabletIdFromTicket(resolved.card, suppliedId);
    return {
      ...resolved,
      tabletId,
      compatibility:legacyInput ? {
        mode:"LEGACY_CARD_COMPAT",
        supported:true,
        blocksWork:false,
        migrationRecommended:true,
        suppliedId:suppliedCardId,
        suggestedTabletId:tabletId,
        recommendation:"ใช้ TABLET:* ในครั้งถัดไป; CARD:* ยังใช้ต่อได้ระหว่างช่วงเปลี่ยนผ่าน",
      } : null,
    };
  }

  function legacyMigrationPolicy(compatibility = null) {
    const legacy = compatibility?.mode === "LEGACY_CARD_COMPAT";
    return {
      entry:{
        acceptsLegacyCard:true,
        blocksWork:false,
        preferredIdentity:"TABLET:*",
      },
      exit:{
        acceptsLegacyCard:true,
        requiresOwnerReadback:true,
        blocksOnMigration:false,
      },
      emergency:{
        acceptsLegacyCard:true,
        migrationGate:false,
        authorityExpanded:false,
        destinationOpened:false,
        exitAction:"return_tablet",
      },
      migration:{
        requiredNow:false,
        recommended:legacy,
        suggestedTabletId:legacy ? compatibility?.suggestedTabletId || null : null,
      },
    };
  }

  function tabletPacket(resolved) {
    const legacy = cardPacket(resolved);
    const tablet = tabletView(
      resolved.current?.mission?.memory?.cardMachine?.current || resolved.card,
      resolved.tabletId,
      resolved.current,
    );
    return {
      tabletId:tablet?.tabletId || resolved.tabletId || null,
      tablet,
      workContext:clone(resolved.workContext),
      lineage:clone(resolved.work?.lineage || null),
      ownerReadback:clone(legacy.ownerReadback),
      compatibility:clone(resolved.compatibility || {
        mode:"CURRENT_TABLET",
        supported:true,
        blocksWork:false,
        migrationRecommended:false,
      }),
      migrationPolicy:legacyMigrationPolicy(resolved.compatibility || null),
    };
  }

  async function createTablet(input = {}) {
    const mission = text(input.mission);
    const requestedResult = text(input.requestedResult);
    if (!mission) return json({ code:"HERMES_MISSION_REQUIRED" }, 400);
    if (!requestedResult) return json({ code:"HERMES_REQUESTED_RESULT_REQUIRED" }, 400);
    const raw = await boardRead();
    const board = await payload(raw);
    if (!okResponse(raw) || !Array.isArray(board?.pins)) {
      return json({ code:"HERMES_HEIMDALL_INDEX_UNAVAILABLE" }, 503);
    }
    const workId = nextCanonicalWorkId({
      mission,
      workKey:input.workKey,
      pins:board.pins,
      at:now(),
    });
    const created = await centre({
      action:"v4_create",
      workId,
      work:{
        workId,
        name:mission,
        command:mission,
        expectedResult:requestedResult,
        requestedDestinations:[],
        scope:[],
        workType:text(input.workType || "NORMAL").toUpperCase(),
      },
    });
    const workContext = { workId:created.work.workId, checkpointId:created.work.checkpointId };
    await centre({ action:"v4_claim", ...workContext, actor:"GO" });
    const sessionId = text(input.sessionId) || createId("HERMES-TABLET");
    await centre({
      action:"v4_mission_enter",
      ...workContext,
      sessionId,
      agentId:text(input.agentId) || "GO",
      mission,
      requestedResult,
    });
    await centre({
      action:"v4_mission_card_prepare",
      ...workContext,
      surface:"TABLET",
      agentId:text(input.agentId) || "GO",
      sessionId,
      initialContext:input.initialContext === undefined ? {} : clone(input.initialContext),
      data:{},
      context:[],
      reason:"TABLET_CREATE",
    });
    await centre({ action:"v4_mission_card_issue", ...workContext, acceptedBy:"GO" });
    const current = await readMission(workContext);
    const resolved = {
      workContext,
      current,
      work:current.work,
      card:current.mission?.memory?.cardMachine?.current || null,
      tabletId:tabletIdFromTicket(current.mission?.memory?.cardMachine?.current),
    };
    return json({
      ok:true,
      action:"create_tablet",
      ...tabletPacket(resolved),
      created:true,
      pickedUp:true,
      entryMode:"CREATE",
      chooser:"GO",
      prompt:"สร้าง Work Tablet และเข้าใช้งานแล้ว จากนี้ GO เลือกข้อมูล/target/tool ใส่แท็บเล็ตเองได้",
    }, 201);
  }

  async function createDerivedTablet(input = {}) {
    const sourceWorkId = text(input.sourceWorkId);
    if (!sourceWorkId) return json({ code:"HERMES_SOURCE_WORK_ID_REQUIRED" }, 400);
    const result = await createTablet({
      ...input,
      creationAction:"v4_create_derived",
      sourceWorkId,
      lineage:normalizeWorkLineage({ ...input.lineage, derivedFrom:sourceWorkId }),
    });
    return result;
  }

  async function pickupTablet(input = {}) {
    const picked = await ensurePickupState(await resolveTabletContext(input));
    return json({
      ok:true,
      action:"pickup_tablet",
      ...tabletPacket(picked),
      pickedUp:true,
      usable:!picked.terminal,
      terminal:picked.terminal === true,
      entryMode:"PICKUP",
      chooser:"GO",
      prompt:picked.terminal
        ? "อ่านแท็บเล็ตได้แล้ว งานอยู่ในสถานะปลายทาง"
        : picked.compatibility?.migrationRecommended
          ? "บัตรเก่ายังใช้ต่อได้และไม่บล็อกงาน · แนะนำเปลี่ยนมาใช้ " + picked.tabletId + " ในครั้งถัดไป"
          : "รับ Work Tablet แล้ว จากนี้เดินงานและเลือกข้อมูลใส่แท็บเล็ตได้เอง",
    });
  }

  async function emergencyTabletEnter(input = {}) {
    let workContext = null;
    let entryCompatibility = null;
    if (text(input.tabletId || input.cardId)) {
      const entryResolved = await resolveTabletContext(input);
      workContext = entryResolved.workContext;
      entryCompatibility = entryResolved.compatibility;
    } else {
      workContext = requireWorkContext(input);
    }
    const enteredResponse = await emergencyEnter({ ...input, workContext });
    const enteredBody = await payload(enteredResponse);
    if (!okResponse(enteredResponse)) return enteredResponse;

    let current = await readMission(workContext);
    let ticket = current.mission?.memory?.cardMachine?.current || null;
    if (!ticket) {
      await centre({
        action:"v4_mission_card_prepare",
        ...workContext,
        surface:"TABLET",
        agentId:text(input.agentId) || "GO",
        sessionId:text(input.sessionId) || current.mission?.session?.sessionId || createId("HERMES-TABLET"),
        initialContext:input.initialContext === undefined ? {} : clone(input.initialContext),
        data:{},
        context:[],
        reason:"EMERGENCY_TABLET_ENTRY",
      });
      await centre({ action:"v4_mission_card_issue", ...workContext, acceptedBy:"GO" });
      current = await readMission(workContext);
      ticket = current.mission?.memory?.cardMachine?.current || null;
    }
    const resolved = {
      workContext,
      current,
      work:current.work,
      card:ticket,
      tabletId:tabletIdFromTicket(ticket),
      compatibility:entryCompatibility,
    };
    return json({
      ...enteredBody,
      ok:true,
      action:"emergency_enter",
      ...tabletPacket(resolved),
      emergency:true,
      entryMode:"EMERGENCY",
      explicitOwnerAction:true,
      destinationOpened:false,
      authorityExpanded:false,
      card:enteredBody.card || workCardView(current.work),
      mission:current.mission,
      readout:composeMissionReadout(current.work, current.mission),
      prompt:entryCompatibility?.migrationRecommended
        ? "เข้าด่วนด้วยบัตรเก่าได้โดยไม่บล็อกงาน · ขาออกใช้ return_tablet และแนะนำเปลี่ยนเป็น " + resolved.tabletId + " ภายหลัง"
        : "เข้าด่วนแล้ว และมี Work Tablet สำหรับถือข้อมูลระหว่างงาน ขาออกใช้ return_tablet",
    });
  }

  async function helpChooseTablet(input = {}) {
    const resolved = await resolveTabletContext(input);
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).map(contextCandidate);
    const tablet = tabletView(resolved.card, resolved.tabletId, resolved.current);
    const memory = resolved.current.mission?.memory || {};
    const query = [
      tablet?.task,
      JSON.stringify(tablet?.initialContext || {}),
      memory.mission,
      memory.requestedResult,
      resolved.work?.command,
      resolved.work?.expectedResult,
    ].filter(Boolean).join(" ");
    const choices = candidates
      .map((candidate, order) => ({ ...candidate, order, fitScore:choiceFitScore(query, candidate) }))
      .sort((a,b) => b.fitScore - a.fitScore || a.order - b.order);
    return json({
      ok:true,
      action:"help_choose",
      tabletId:resolved.tabletId,
      workContext:resolved.workContext,
      choices,
      currentContext:clone(tablet?.initialContext || {}),
      selectedAutomatically:false,
      chooser:"GO",
      mutates:false,
      instruction:"HERMES ช่วยจัดตัวเลือกเท่านั้น ไม่เขียนอะไรลง Work Tablet จนกว่า GO จะใช้ update_tablet เอง",
    });
  }

  async function updateTablet(input = {}) {
    let resolved = await ensurePickupState(await resolveTabletContext(input));
    if (resolved.terminal) {
      return json({ code:"HERMES_TERMINAL_TABLET_UPDATE_FORBIDDEN", tabletId:resolved.tabletId }, 409);
    }
    const currentTicket = resolved.current.mission?.memory?.cardMachine?.current || resolved.card;
    if (!currentTicket) return json({ code:"HERMES_CURRENT_TABLET_REQUIRED" }, 409);
    const initialContext = input.initialContext === undefined
      ? clone(currentTicket.initialContext !== undefined ? currentTicket.initialContext : (currentTicket.context || {}))
      : clone(input.initialContext);
    const status = text(input.status || currentTicket.status || resolved.work.status).toUpperCase() || "ON PROCESS";
    const result = input.result === undefined ? clone(currentTicket.result ?? null) : clone(input.result);
    const evidence = input.evidence === undefined ? clone(currentTicket.evidence || []) : clone(input.evidence);
    await centre({
      action:"v4_mission_card_prepare",
      ...resolved.workContext,
      surface:"TABLET",
      agentId:text(input.agentId) || resolved.current.mission?.session?.agentId || "GO",
      sessionId:text(input.sessionId) || resolved.current.mission?.session?.sessionId || null,
      initialContext,
      data:{},
      context:[],
      status,
      result,
      evidence,
      reason:"GO_TABLET_UPDATE",
    });
    const committed = await centre({
      action:"v4_mission_card_replace",
      ...resolved.workContext,
      confirmation:"GO_CONFIRMED",
    });
    resolved = {
      ...resolved,
      current:{ work:committed.work, mission:committed.mission },
      work:committed.work,
      card:committed.card || committed.mission?.memory?.cardMachine?.current || null,
      tabletId:tabletIdFromTicket(committed.card || committed.mission?.memory?.cardMachine?.current, resolved.tabletId),
    };
    return json({
      ok:true,
      action:"update_tablet",
      ...tabletPacket(resolved),
      manual:true,
      chooser:"GO",
      selectedAutomatically:false,
      prompt:"บันทึกข้อมูลใบงานแล้ว ความพร้อมใช้งานและเส้นทางถูกตัดสินโดย backend policy",
    });
  }

  async function resumeTablet(input = {}) {
    const resolvedBefore = await resolveTabletContext(input);
    const currentTicket = resolvedBefore.current.mission?.memory?.cardMachine?.current || resolvedBefore.card;
    const reality = resolvedBefore.current.mission?.memory?.latestReality || {};
    const recovery = tabletRecoveryView(currentTicket, reality, resolvedBefore.current);
    if (recovery.mode !== "HOLD") {
      return json({
        code:"HERMES_TABLET_NOT_ON_HOLD",
        action:"resume_tablet",
        tabletId:resolvedBefore.tabletId,
        workContext:resolvedBefore.workContext,
        recovery,
      }, 409);
    }
    const resumed = await ensurePickupState(resolvedBefore);
    const current = await readMission(resumed.workContext);
    const resolved = {
      ...resumed,
      current,
      work:current.work,
      card:current.mission?.memory?.cardMachine?.current || resumed.card,
      tabletId:tabletIdFromTicket(current.mission?.memory?.cardMachine?.current, resumed.tabletId),
    };
    return json({
      ok:true,
      action:"resume_tablet",
      ...tabletPacket(resolved),
      resumed:true,
      resumedFrom:recovery,
      prompt:"Resume แล้ว ต่อจาก Work และ checkpoint เดิม โดย HERMES ไม่สร้าง Work ใหม่",
    });
  }

  async function returnTablet(input = {}) {
    const resolvedBefore = await ensurePickupState(await resolveTabletContext(input));
    const returnedResponse = await returnCard({
      ...input,
      workContext:resolvedBefore.workContext,
    });
    const returnedBody = await payload(returnedResponse);
    if (!okResponse(returnedResponse)) return returnedResponse;
    await centre({ action:"v4_mission_card_update", ...resolvedBefore.workContext });
    await centre({ action:"v4_mission_exit", ...resolvedBefore.workContext });
    const final = await resolveTabletContext({ tabletId:resolvedBefore.tabletId });
    const returned = {
      ...final,
      compatibility:resolvedBefore.compatibility || final.compatibility,
    };
    return json({
      ok:true,
      action:"return_tablet",
      ...tabletPacket(returned),
      returned:true,
      exitMode:"RETURN",
      readbackVerified:returnedBody.readbackVerified === true || returnedBody.idempotent === true,
      sessionClosed:true,
      retrievalCode:final.card?.snapshot_key || missionTicketSearchCode(final.workContext.workId),
      prompt:resolvedBefore.compatibility?.migrationRecommended
        ? "คืนงานและ readback แล้วโดยไม่บังคับย้ายบัตร · ครั้งถัดไปแนะนำใช้ " + resolvedBefore.tabletId
        : "คืน Work Tablet แล้ว ผลและหลักฐานถูกเก็บไว้สำหรับหยิบมาทำต่อครั้งหน้า",
    });
  }

  async function ejectTablet(input = {}) {
    const resolvedBefore = await ensurePickupState(await resolveTabletContext(input));
    if (resolvedBefore.terminal) {
      return json({ code:"HERMES_TERMINAL_TABLET_EJECT_FORBIDDEN", tabletId:resolvedBefore.tabletId }, 409);
    }
    const recovery = recoveryDetails(input, resolvedBefore, "INTERRUPTED");
    const returnedResponse = await returnCard({
      ...input,
      workContext:resolvedBefore.workContext,
      status:text(input.status || "WAIT").toUpperCase(),
      mode:"INTERRUPTED_EJECT",
      recovery,
      unknowns:input.unknowns === undefined ? recovery.unknownGap : input.unknowns,
      lastLocation:input.lastLocation || recovery.lastLocation,
    });
    const returnedBody = await payload(returnedResponse);
    if (!okResponse(returnedResponse)) return returnedResponse;
    await centre({ action:"v4_mission_card_update", ...resolvedBefore.workContext });
    await centre({ action:"v4_mission_exit", ...resolvedBefore.workContext });
    const final = await resolveTabletContext({ tabletId:resolvedBefore.tabletId });
    return json({
      ok:true,
      action:"eject_tablet",
      ...tabletPacket(final),
      ejected:true,
      interrupted:true,
      exitMode:"EJECT",
      recovery:clone(final.current?.mission?.memory?.latestReality?.recovery || recovery),
      readbackVerified:returnedBody.readbackVerified === true || returnedBody.idempotent === true,
      noAutoRetry:true,
      noAutoRollback:true,
      sessionClosed:true,
      retrievalCode:final.card?.snapshot_key || missionTicketSearchCode(final.workContext.workId),
      prompt:"หยุด action ใหม่แล้ว เก็บ Last Known State ไว้ใน HERMES HOLD; ห้าม retry/rollback อัตโนมัติก่อน inspect และ reconcile",
    });
  }

  async function pickupCard(input = {}) {
    const picked = await ensurePickupState(await resolveCardContext(input));
    return json({
      ok:true,
      action:"pickup_card",
      ...cardPacket(picked),
      pickedUp:true,
      usable:!picked.terminal,
      terminal:picked.terminal === true,
      selectedAutomatically:false,
      chooser:"GO",
      prompt:picked.terminal
        ? "อ่านการ์ดได้แล้ว งานอยู่ในสถานะปลายทาง จึงยังไม่เปิดให้ทำ effect ใหม่"
        : "รับการ์ดแล้ว ใช้ tool_access บนการ์ดได้ตรง ๆ โดยไม่ต้อง first_open หรือผ่าน HERMES อีก",
    });
  }

  async function helpChoose(input = {}) {
    const resolved = await resolveCardContext(input);
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).map(contextCandidate);
    const memory = resolved.current.mission?.memory || {};
    const query = [
      resolved.card?.intent?.mission,
      resolved.card?.intent?.requestedResult,
      memory.mission,
      memory.requestedResult,
      resolved.work?.command,
      resolved.work?.expectedResult,
    ].filter(Boolean).join(" ");
    const choices = candidates
      .map((candidate, order) => ({
        ...candidate,
        order,
        fitScore:choiceFitScore(query, candidate),
      }))
      .sort((a,b) => b.fitScore - a.fitScore || a.order - b.order);
    return json({
      ok:true,
      action:"help_choose",
      cardId:resolved.cardId,
      workContext:resolved.workContext,
      choices,
      currentSelection:clone(resolved.card?.context || memory.selectedContext || []),
      selectedAutomatically:false,
      chooser:"GO",
      mutates:false,
      instruction:"HERMES ช่วยจัดตัวเลือกและความเกี่ยวข้องเท่านั้น GO ต้องเป็นผู้ส่ง selectedIds เอง",
    });
  }

  async function applySelection(input = {}) {
    let resolved = await ensurePickupState(await resolveCardContext(input));
    if (resolved.terminal) {
      return json({ code:"HERMES_TERMINAL_CARD_SELECTION_FORBIDDEN", cardId:resolved.cardId }, 409);
    }
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).map(contextCandidate);
    const selectedIds = unique(input.selectedIds);
    if (!selectedIds.length) {
      return json({
        code:"HERMES_GO_SELECTION_REQUIRED",
        cardId:resolved.cardId,
        selectedAutomatically:false,
        chooser:"GO",
      }, 409);
    }
    const selectedSet = new Set(selectedIds);
    const selected = candidates.filter(item => selectedSet.has(item.contextId));
    if (selected.length !== selectedSet.size) {
      return json({ code:"HERMES_SELECTION_UNKNOWN_ID", cardId:resolved.cardId }, 400);
    }

    const stored = await centre({
      action:"v4_mission_context",
      ...resolved.workContext,
      candidates,
      selectedIds,
    });
    const currentCard = stored.mission?.memory?.cardMachine?.current || resolved.current.mission?.memory?.cardMachine?.current || null;
    const chosenDestinations = unique(input.destinations?.length
      ? input.destinations
      : selected.map(item => item.destination));
    const chosenTools = unique(input.toolAccess?.length
      ? input.toolAccess
      : selected.map(item => item.tool));
    const destinations = chosenDestinations.length
      ? chosenDestinations
      : unique(currentCard?.destinations || resolved.work.requestedDestinations);
    const toolAccess = chosenTools.length
      ? chosenTools
      : unique(currentCard?.tool_access);
    if (!toolAccess.length) {
      return json({
        code:"HERMES_GO_TOOL_SELECTION_REQUIRED",
        cardId:resolved.cardId,
        selectedAutomatically:false,
        chooser:"GO",
        choices:selected,
      }, 409);
    }
    const workType = text(resolved.work.workType).toUpperCase();
    const accessScope = text(input.accessScope || currentCard?.access_scope || resolved.work.accessScope ||
      (workType === "MAINTENANCE" ? "MAINTENANCE" : "WORK")).toUpperCase();
    if (!["WORK","MAINTENANCE"].includes(accessScope)) {
      return json({ code:"HERMES_ACCESS_SCOPE_REQUIRED" }, 409);
    }

    await centre({
      action:"v4_mission_card_prepare",
      ...resolved.workContext,
      destinations,
      accessScope,
      toolAccess,
      reason:"GO_SELECTION",
      context:selected,
    });
    const committed = currentCard
      ? await centre({ action:"v4_mission_card_replace", ...resolved.workContext, confirmation:"GO_CONFIRMED" })
      : await centre({ action:"v4_mission_card_issue", ...resolved.workContext, acceptedBy:"GO" });
    resolved = {
      ...resolved,
      current:{ work:committed.work, mission:committed.mission },
      work:committed.work,
      card:committed.card || committed.mission?.memory?.cardMachine?.current || null,
    };
    return json({
      ok:true,
      action:"apply_selection",
      ...cardPacket(resolved),
      selectedIds,
      selectedAutomatically:false,
      chooser:"GO",
      routeOpened:false,
      passOpened:false,
      prompt:"เขียนเฉพาะตัวเลือกที่ GO เลือกลงการ์ดแล้ว ใช้เครื่องมือบนการ์ดได้ตรง ๆ",
    });
  }

  async function returnCardById(input = {}) {
    let resolved = await ensurePickupState(await resolveCardContext(input));
    const requestedStatus = text(input.status || "ON PROCESS").toUpperCase();
    const ownerStatus = text(resolved.work.status).toUpperCase();
    if (resolved.terminal) {
      const sameTerminal = (ownerStatus === "COMPLETE" && requestedStatus === "COMPLETE") ||
        (ownerStatus === "CANCEL" && requestedStatus === "CANCEL");
      if (!sameTerminal) {
        return json({ code:"HERMES_TERMINAL_CARD_RETURN_CONFLICT", cardId:resolved.cardId, ownerStatus }, 409);
      }
      return json({
        ok:true,
        action:"return_card",
        ...cardPacket(resolved),
        returned:true,
        idempotent:true,
        sessionClosed:true,
      });
    }

    const legacyResponse = await returnCard({ ...input, workContext:resolved.workContext });
    const legacyBody = await payload(legacyResponse);
    if (!okResponse(legacyResponse)) {
      return legacyResponse;
    }
    await centre({ action:"v4_mission_card_update", ...resolved.workContext });
    await centre({ action:"v4_mission_exit", ...resolved.workContext });
    const final = await readMission(resolved.workContext);
    resolved = {
      ...resolved,
      current:final,
      work:final.work || legacyBody.card || resolved.work,
      card:final.mission?.memory?.cardMachine?.current || resolved.card,
    };
    return json({
      ok:true,
      action:"return_card",
      ...cardPacket(resolved),
      returned:true,
      readbackVerified:legacyBody.readbackVerified === true,
      sessionClosed:true,
      retrievalCode:resolved.card?.snapshot_key || missionTicketSearchCode(resolved.workContext.workId),
      prompt:"คืนการ์ดแล้ว ผล/หลักฐานถูกเก็บบนการ์ดและปิด HERMES session ให้เรียบร้อย",
    });
  }

  async function issueCard(input = {}) {
    const workContext = requireWorkContext(input);
    const current = await readMission(workContext);
    const work = current.work || await inspectWork(workContext);
    const destinations = unique(input.destinations?.length ? input.destinations : work.requestedDestinations);
    const workType = text(work.workType).toUpperCase();
    const passKind = text(work.pass?.kind).toUpperCase();
    const persistedScope = text(work.accessScope).toUpperCase();
    const maintenanceDestination = destinations.some(destination => text(destination).replace(/^destination:\/\//, "").toLowerCase() === "maintenance");
    const accessScope = workType === "MAINTENANCE" || passKind === "MAINTENANCE" || persistedScope === "MAINTENANCE" || maintenanceDestination
      ? "MAINTENANCE"
      : "WORK";
    let recommendedTools = accessScope === "MAINTENANCE"
      ? unique(destinations.flatMap(destinationTools))
      : unique(current.mission?.memory?.recommendedTools);
    // Card issuance must not search Work history. Tool suggestions come from mission memory or declared destinations.
    if (!recommendedTools.length) {
      recommendedTools = unique(destinations.flatMap(destinationTools));
    }
    if (accessScope === "WORK" && !recommendedTools.length) return json({
      code:"HERMES_TOOL_RECOMMENDATION_REQUIRED",
      prompt:"ข้อมูลเครื่องมือยังไม่พอ HERMES ต้องค้นหา/วิเคราะห์เครื่องมือที่เหมาะกับ Mission ก่อนออก Standard Card",
    }, 409);
    await centre({
      action:"v4_mission_card_prepare",
      ...workContext,
      destinations,
      accessScope,
      toolAccess:recommendedTools,
      reason:text(input.reason) || "MISSION_ENTRY",
      context:clone(current.mission?.memory?.selectedContext || []),
    });
    const response = await centre({ action:"v4_mission_card_issue", ...workContext });
    return json({
      ok:true,
      action:"issue_card",
      workContext,
      card:response.mission?.memory?.cardMachine?.current || null,
      issued:true,
      prompt:"Standard Card พร้อมใช้งานครับ",
    });
  }

  async function prepareRouteChange(input = {}) {
    const workContext = requireWorkContext(input);
    const current = await readMission(workContext);
    const machine = current.mission?.memory?.cardMachine || {};
    if (!machine.current) return json({ code:"HERMES_CURRENT_CARD_REQUIRED" }, 409);
    const requested = unique(input.destinations);
    const destinations = unique([...(machine.current.destinations || []), ...requested]);
    const accessScope = text(input.accessScope || machine.current.access_scope).toUpperCase();
    const toolAccess = input.toolAccess?.length ? unique(input.toolAccess) : unique(machine.current.tool_access);
    if (!["WORK","MAINTENANCE"].includes(accessScope)) return json({ code:"HERMES_ACCESS_SCOPE_REQUIRED" }, 409);
    if (accessScope === "WORK" && !toolAccess.length) return json({ code:"HERMES_TOOL_ACCESS_REQUIRED" }, 409);
    const response = await centre({
      action:"v4_mission_card_prepare",
      ...workContext,
      destinations,
      accessScope,
      toolAccess,
      reason:text(input.reason) || "PERMISSION_CHANGE",
      context:clone(current.mission?.memory?.selectedContext || []),
    });
    return json({
      ok:true,
      action:"prepare_route_change",
      workContext,
      currentCard:machine.current,
      replacementDraft:response.mission?.memory?.cardMachine?.draft || null,
      issued:false,
      routeChanged:false,
      prompt:"ตรวจสอบสิทธิ์ใหม่บนการ์ดแล้วครับ ก่อนออกบัตรใหม่ต้องได้รับการอนุมัติจาก BIG",
    });
  }

  async function confirmRouteChange(input = {}) {
    const workContext = requireWorkContext(input);
    if (text(input.confirmation).toUpperCase() !== "GO_CONFIRMED") {
      return json({ code:"HERMES_GO_FINAL_CONFIRMATION_REQUIRED", replaced:false }, 409);
    }
    const response = await centre({ action:"v4_mission_card_replace", ...workContext, confirmation:"GO_CONFIRMED" });
    return json({
      ok:true,
      action:"confirm_route_change",
      workContext,
      card:response.card || response.mission?.memory?.cardMachine?.current || null,
      replaced:true,
      routeOpened:false,
      audit:response.audit || null,
      readout:composeMissionReadout(response.work, response.mission),
      prompt:"เรียบร้อยครับ Route ที่ยืนยันแล้วถูกเขียนกลับ Owner Work และออกการ์ดใบใหม่พร้อมกัน โดยยังไม่เปิดปลายทางจนกว่าจะ first_open",
    });
  }

  async function selectContext(input = {}) {
    const workContext = requireWorkContext(input);
    const candidates = (Array.isArray(input.candidates) ? input.candidates : []).map(contextCandidate);
    const selectedIds = unique(input.selectedIds);
    const response = await centre({
      action:"v4_mission_context",
      ...workContext,
      candidates,
      selectedIds,
    });
    return json({ ok:true, action:"select_context", workContext, mission:response.mission });
  }

  async function note(input = {}) {
    const workContext = requireWorkContext(input);
    const noteText = text(input.note);
    if (!noteText) return json({ code:"HERMES_NOTE_REQUIRED" }, 400);
    const response = await centre({
      action:"v4_mission_note",
      ...workContext,
      note:noteText,
      source:text(input.source) || "GO",
    });
    return json({ ok:true, action:"note", workContext, mission:response.mission });
  }

  async function askLight(input = {}) {
    const workContext = requireWorkContext(input);
    const question = text(input.question);
    if (!question) return json({ code:"HERMES_LIGHT_QUESTION_REQUIRED" }, 400);
    const current = await readMission(workContext);
    const mission = current.mission;
    if (!mission?.session || mission.session.status === "EXITED") {
      return json({ code:"HERMES_ACTIVE_SESSION_REQUIRED" }, 409);
    }
    const counterId = text(input.counterId) || createId("HERMES-LIGHT");
    const response = await counterDispatch.create({
      counterId,
      mode:"SEARCH",
      request:question,
      requestedResult:text(input.requestedResult) || "Return relevant mission context with source references.",
      authority:"READ_CONTEXT_ONLY",
      target:"LIGHT",
      fromActor:"GO",
      toActor:"LIGHT",
      context:{
        hermes:true,
        mission:mission.memory?.mission || null,
        cardId:workCardView(current.work).cardId,
        selectedContext:clone(mission.memory?.selectedContext || []),
        contextRefs:clone(mission.memory?.contextRefs || []),
      },
      sourceHints:clone(mission.memory?.contextRefs || []),
      doNotChange:["Mission Card identity","selected context","Work truth"],
      workContext,
    });
    const body = await payload(response);
    const lightResult = body.lightResult || body.counter?.answer || null;
    const candidates = lightResult ? lightCandidates(lightResult) : [];
    const stored = await centre({
      action:"v4_mission_light",
      ...workContext,
      lightReply:{
        counterId,
        status:lightResult?.status || (body.lightAuthRequired ? "WAITING_AUTH" : "UNKNOWN"),
        answer:lightResult?.answer || null,
        sources:unique(lightResult?.sources),
        evidence:clone(lightResult?.evidence || []),
        candidates,
        authRequired:body.lightAuthRequired === true,
        receivedAt:now(),
      },
    });
    return json({
      ok:response?.ok !== false,
      action:"ask_light",
      workContext,
      counterId,
      lightResult,
      candidates,
      selectedAutomatically:false,
      lightAuthRequired:body.lightAuthRequired === true,
      lightAuthorizationUrl:body.lightAuthorizationUrl || null,
      mission:stored.mission,
    }, response?.status || 200);
  }

  async function ensureRuntimeAccess(workContext, destination, alreadyProvisioned) {
    let work = await inspectWork(workContext);
    const normalizedDestination = text(destination);
    if (!normalizedDestination) throw Object.assign(new Error("HERMES_DESTINATION_REQUIRED"), { status:400 });

    const requested = unique(work.requestedDestinations);
    if (!requested.some(destination => sameDestination(destination, normalizedDestination))) {
      throw Object.assign(new Error("HERMES_ROUTE_CHANGE_REQUIRED"), {
        status:409,
        body:{ destination:normalizedDestination, requestedDestinations:requested },
      });
    }

    if (work.status === "WAIT CONFIRM") {
      const resumed = await centre({ action:"v4_resume", ...workContext, actor:"GO" });
      work = resumed.work;
    } else if (work.status === "OPEN") {
      const claimed = await centre({ action:"v4_claim", ...workContext, actor:"GO" });
      work = claimed.work;
    }

    if (work.status !== "ON PROCESS" || text(work.holder) !== "GO") {
      throw Object.assign(new Error("HERMES_GO_HOLDER_REQUIRED"), { status:409 });
    }

    if (work.pass?.state === "ACTIVE" && workDestinationAllowed(work, normalizedDestination)) {
      return { work, passOpened:false, alreadyProvisioned };
    }

    throw Object.assign(new Error("HERMES_ACTIVE_PASS_REQUIRED"), {
      status:409,
      body:{
        destination:normalizedDestination,
        authorityCreated:false,
        routeChanged:false,
        hint:"Destination is on the Work route, but HERMES does not create Authority. Open an authorized Pass explicitly, then call first_open again.",
      },
    });
  }

  function factoryField(value, source, confidence = "VERIFIED") {
    const normalized = typeof value === "string" ? text(value) : clone(value);
    const present = Array.isArray(normalized) ? normalized.length > 0 : normalized != null && normalized !== "";
    return { value:present ? normalized : null, source:text(source) || null, confidence:present ? confidence : "UNKNOWN" };
  }

  async function prepareFactoryCard(input = {}) {
    const workContext = requireWorkContext(input);
    const current = await readMission(workContext);
    const work = current.work || await inspectWork(workContext);
    const memory = current.mission?.memory || {};
    const supplied = input.factory || {};
    const fields = {
      goal:factoryField(supplied.goal || memory.mission || work.command || work.name, supplied.goal ? "GO" : "MISSION"),
      repository:factoryField(supplied.repository, supplied.repository ? "GO" : null),
      branch:factoryField(supplied.branch, supplied.branch ? "GO" : null),
      expectedOutput:factoryField(supplied.expectedOutput || memory.requestedResult || work.expectedResult, supplied.expectedOutput ? "GO" : "MISSION"),
      outputType:factoryField(supplied.outputType, supplied.outputType ? "GO" : null),
      inputReferences:factoryField(supplied.inputReferences || memory.contextRefs, supplied.inputReferences ? "GO" : "MISSION"),
      preProductionInspection:factoryField(supplied.preProductionInspection, supplied.preProductionInspection ? "GO" : null),
      criticalChecklist:factoryField(supplied.criticalChecklist, supplied.criticalChecklist ? "GO" : null),
    };
    const uncertainFields = Object.entries(fields)
      .filter(([, field]) => field.confidence !== "VERIFIED")
      .map(([name]) => name);
    const draft = Object.fromEntries(Object.entries(fields).map(([name, field]) => [name, field.value]));
    const suppliedChoices = input.choices && typeof input.choices === "object" ? input.choices : {};
    const knowledgeCandidates = [
      ...(Array.isArray(memory.selectedContext) ? memory.selectedContext : []),
      ...(Array.isArray(memory.lightReplies) ? memory.lightReplies.flatMap(reply => Array.isArray(reply?.candidates) ? reply.candidates : []) : []),
    ];
    const assistance = uncertainFields.map(field => {
      const explicit = Array.isArray(suppliedChoices[field]) ? suppliedChoices[field] : [];
      const inferred = knowledgeCandidates
        .filter(item => text(item?.field || item?.kind).toLowerCase() === field.toLowerCase())
        .map(item => ({ value:item.value ?? item.ref ?? null, label:text(item.label || item.summary || item.ref), source:text(item.source || "MISSION_CONTEXT") }))
        .filter(item => item.value != null);
      const choices = [...explicit.map(value => typeof value === "object" ? clone(value) : ({ value, label:text(value), source:"PROVIDED_CHOICE" })), ...inferred];
      return {
        field,
        choices,
        mode:choices.length ? "GO_SELECT" : "ASK_LIGHT_OR_GO",
        instruction:choices.length
          ? "เสนอเฉพาะตัวเลือกที่มีหลักฐานให้ GO เลือก ห้าม HERMES เลือกแทน"
          : "ค้น Mission Context/LIGHT ก่อน ถ้ายังไม่มีหลักฐานจึงถาม GO แบบปลายเปิด ห้ามเดา",
      };
    });
    return json({
      ok:uncertainFields.length === 0,
      action:"prepare_factory_card",
      workContext,
      card:workCardView(work),
      factoryFormDraft:draft,
      fieldEvidence:fields,
      uncertainFields,
      assistance,
      status:uncertainFields.length ? "WAIT_GO_INPUT" : "WAIT_GO_CONFIRMATION",
      prompt:uncertainFields.length
        ? "ผมพบข้อมูลที่ยังยืนยันไม่ได้ จะค้นข้อมูลที่มีอยู่และเสนอทางเลือกให้ GO ก่อน หากยังไม่มีหลักฐานจึงขอให้ GO ระบุเองครับ"
        : "นี่ครับบัตรของคุณ รบกวนตรวจสอบข้อมูลอีกครั้ง รบกวนยืนยันครับ",
      issued:false,
      currentCardChanged:false,
    }, uncertainFields.length ? 409 : 200);
  }

  async function confirmFactoryCard(input = {}) {
    const workContext = requireWorkContext(input);
    if (text(input.confirmation).toUpperCase() !== "GO_CONFIRMED") {
      return json({ code:"HERMES_GO_FINAL_CONFIRMATION_REQUIRED", issued:false }, 409);
    }
    const prepared = await prepareFactoryCard({ ...input, action:"prepare_factory_card" });
    const preparedBody = await payload(prepared);
    if (!okResponse(prepared)) return prepared;
    return json({
      ok:true,
      action:"confirm_factory_card",
      workContext,
      card:preparedBody.card,
      factoryForm:preparedBody.factoryFormDraft,
      fieldEvidence:preparedBody.fieldEvidence,
      status:"ISSUED",
      issued:true,
      acceptedBy:"GO",
      prompt:"ยืนยันแล้ว — GO รับบัตรและสามารถนำ Factory Form นี้เข้าสู่ Inspection/Factory ได้",
    });
  }

  async function firstOpen(input = {}) {
    const workContext = requireWorkContext(input);
    const destination = text(input.destination);
    if (!destination) return json({ code:"HERMES_DESTINATION_REQUIRED" }, 400);
    const current = await readMission(workContext);
    const openedSpaces = current.mission?.memory?.openedSpaces || {};
    const alreadyProvisioned = Boolean(openedSpaces[destination]);
    const access = await ensureRuntimeAccess(workContext, destination, alreadyProvisioned);
    const recorded = await centre({
      action:"v4_mission_first_open",
      ...workContext,
      destination,
      workspace:text(input.workspace) || null,
      firstOpen:!alreadyProvisioned,
      access:{
        passKind:access.work?.pass?.kind || null,
        passState:access.work?.pass?.state || null,
        openedBy:access.work?.pass?.openedBy || "heimdall",
      },
    });
    return json({
      ok:true,
      action:"first_open",
      workContext,
      status:alreadyProvisioned ? "ALREADY_OPEN" : "OPENED",
      runtimePassOpened:access.passOpened,
      card:workCardView(access.work),
      mission:recorded.mission,
      readout:composeMissionReadout(access.work, recorded.mission),
    });
  }

  async function touch(input = {}) {
    const workContext = requireWorkContext(input);
    const current = await readMission(workContext);
    const work = current.work || await inspectWork(workContext);
    const memory = current.mission?.memory || null;
    const refs = (memory?.selectedContext || [])
      .flatMap(item => [item?.ref, ...(Array.isArray(item?.refs) ? item.refs : [])])
      .filter(Boolean)
      .map(ref => ({ label:"mission-context", ref }));
    return json({
      ok:true,
      action:"touch",
      station:text(input.station) || "UNKNOWN",
      card:workCardView(work),
      pointer:createMissionCard({
        workId:work.workId,
        checkpointId:work.checkpointId,
        jobCode:work.jobCode,
        references:refs,
      }),
      memory:clone(memory),
      authorityCreated:false,
      boardExposed:false,
    });
  }

  async function returnCard(input = {}) {
    const workContext = requireWorkContext(input);
    const missionStatus = text(input.status || "ON PROCESS").toUpperCase();
    const allowed = new Set(["ON PROCESS","WAIT","WAIT VERIFY","BLOCKED","UNKNOWN","COMPLETE","CANCEL"]);
    if (!allowed.has(missionStatus)) return json({ code:"HERMES_RETURN_STATUS_INVALID" }, 400);
    const centreStatus = missionStatus === "COMPLETE" ? "COMPLETE" : missionStatus === "CANCEL" ? "CANCEL" : "OPEN";
    const lifecycle = missionReturnLifecycle(missionStatus);
    const evidence = evidenceRefs(input.evidence);
    if (centreStatus === "COMPLETE" && !evidence.length) {
      return json({ code:"HERMES_COMPLETE_EVIDENCE_REQUIRED" }, 409);
    }

    const returned = await centre({
      action:"v4_return",
      ...workContext,
      actor:"GO",
      status:centreStatus,
      result:clone(input.result),
      evidence,
    });
    const work = returned.work;
    const recovery = input.recovery && typeof input.recovery === "object" && !Array.isArray(input.recovery)
      ? clone(input.recovery)
      : ["INTERRUPTED", "EJECT", "INTERRUPTED_EJECT"].includes(text(input.mode).toUpperCase())
        ? recoveryDetails(input, { ...resolvedBefore, current:await readMission(workContext) }, "INTERRUPTED")
        : null;
    const recorded = await centre({
      action:"v4_mission_return",
      ...workContext,
      missionStatus,
      result:clone(input.result),
      nextAction:text(input.nextAction) || null,
      evidence,
      unknowns:unique(input.unknowns),
      lastLocation:text(input.lastLocation) || null,
      mode:text(input.mode || "NORMAL_RETURN").toUpperCase(),
      recovery,
      universalLifecycle:lifecycle,
      ownerReadback:{
        sourceStatus:work.status,
        holder:work.holder || null,
        passState:work.pass?.state || null,
        lastUpdated:work.lastUpdated || null,
      },
    });
    return json({
      ok:true,
      action:"return",
      workContext,
      card:workCardView(work),
      mission:recorded.mission,
      lifecycle,
      readout:composeMissionReadout(work, recorded.mission),
      readbackVerified:true,
      exitAllowed:true,
      cardUpdateRequired:false,
      retrievalCode:recorded.mission?.memory?.cardMachine?.current?.snapshot_key || missionTicketSearchCode(work.workId),
      prompt:"Return และ owner readback เรียบร้อย พร้อมออกจาก Mission ได้เลยครับ",
    });
  }

  async function updateCard(input = {}) {
    const workContext = requireWorkContext(input);
    const response = await centre({ action:"v4_mission_card_update", ...workContext });
    return json({ ok:true, action:"update_card", workContext, card:workCardView(response.work), mission:response.mission, updated:true, prompt:"อัปเดตการ์ดแล้วครับ พร้อมออกจาก Mission" });
  }

  async function exit(input = {}) {
    const workContext = requireWorkContext(input);
    const response = await centre({ action:"v4_mission_exit", ...workContext });
    return json({
      ok:true,
      action:"exit",
      workContext,
      mission:response.mission,
      exited:true,
    });
  }

  async function inspect(input = {}) {
    const workContext = requireWorkContext(input);
    const response = await readMission(workContext);
    return json({
      ok:true,
      action:"inspect",
      workContext,
      work:response.work,
      card:workCardView(response.work),
      mission:response.mission,
      readout:composeMissionReadout(response.work, response.mission),
    });
  }

  return Object.freeze({
    async action(input = {}) {
      try {
        switch (text(input.action).toLowerCase()) {
          case "create_tablet": return await createTablet(input);
          case "create_derived_tablet": return await createDerivedTablet(input);
          case "pickup_tablet": return await pickupTablet(input);
          case "emergency_enter": return await emergencyTabletEnter(input);
          case "help_choose": return await helpChooseTablet(input);
          case "update_tablet": return await updateTablet(input);
          case "resume_tablet": return await resumeTablet(input);
          case "eject_tablet": return await ejectTablet(input);
          case "return_tablet": return await returnTablet(input);
          case "pickup_card": return await pickupCard(input);
          case "apply_selection": return await applySelection(input);
          case "return_card": return await returnCardById(input);
          case "find": return await find(input);
          case "enter": return await enter(input);
          case "reopen": return await reopen(input);
          case "manual_continue": return await manualContinue(input);
          case "emergency_exit": return await emergencyExit(input);
          case "create": return await create(input);
          case "issue_card": return await issueCard(input);
          case "prepare_route_change": return await prepareRouteChange(input);
          case "confirm_route_change": return await confirmRouteChange(input);
          case "select_context": return await selectContext(input);
          case "note": return await note(input);
          case "ask_light": return await askLight(input);
          case "prepare_factory_card": return await prepareFactoryCard(input);
          case "confirm_factory_card": return await confirmFactoryCard(input);
          case "first_open": return await firstOpen(input);
          case "touch": return await touch(input);
          case "return": return await returnCard(input);
          case "update_card": return await updateCard(input);
          case "exit": return await exit(input);
          case "inspect": return await inspect(input);
          default: return json({ code:"HERMES_ACTION_INVALID" }, 400);
        }
      } catch (error) {
        const hasWorkContext = Boolean(text(input?.workContext?.workId || input.workId) && text(input?.workContext?.checkpointId || input.checkpointId));
        return json({
          code:error?.message || "HERMES_ACTION_FAILED",
          ...(error?.body ? { cause:error.body } : {}),
          ...(hasWorkContext ? { manualControls:fallbackManualControls() } : {}),
        }, Number(error?.status || 500));
      }
    },
  });
}
