/**
 * MIMIR Logic v1
 *
 * Design-phase canonical schemas and pure transformations only.
 * This module defines Centre-owned derived organization for HERMES and SPECTRUM consumers only.\n * PIXIE case organization is deliberately separate and must not consume Centre-MIMIR state.
 */

export const MIMIR_LOGIC_VERSION = "MIMIR_LOGIC_V1";

export const LIFECYCLE_STATUS = Object.freeze([
  "current",
  "stale",
  "legacy",
  "smoke",
  "unknown",
  "quarantine",
  "restricted",
  "conflict",
]);

export const DUPLICATE_STATE = Object.freeze([
  "none",
  "exact",
  "identity",
  "possible",
]);

export const LINEAGE_EDGE_TYPES = Object.freeze([
  "OBSERVED_FROM",
  "NORMALIZED_FROM",
  "DERIVED_FROM",
  "DUPLICATE_OF",
  "SAME_TOPIC_AS",
  "SUPERSEDES",
  "SUPERSEDED_BY",
  "ARCHIVED_AS",
  "SUMMARIZED_IN",
]);

export const CONSUMERS = Object.freeze(["HERMES", "SPECTRUM"]);

export const RETURN_ITEM_KINDS = Object.freeze([
  "RESULT",
  "EVIDENCE",
  "ARTIFACT",
  "STATUS",
  "RECEIPT",
  "METADATA",
  "KNOWLEDGE",
]);

export const HOUSEKEEPING_ACTIONS = Object.freeze([
  "STORE",
  "ARCHIVE",
  "QUARANTINE",
  "DELETE_CANDIDATE",
]);


export const MIMIR_V1_SCHEMA = Object.freeze({
  ObservationEnvelope: Object.freeze([
    "observationId",
    "source",
    "capturedAt",
    "observedAt",
    "schemaVersion",
    "content",
    "evidenceRefs",
    "accessScope",
  ]),
  CanonicalRecord: Object.freeze([
    "recordId",
    "canonicalKey",
    "lifecycleStatus",
    "duplicateState",
    "confidence",
    "sourceRefs",
    "evidenceRefs",
    "lineage",
    "truthOwner",
    "canMutateSource",
    "routeHint",
    "routeEvidenceRefs",
    "routeDerivedByMimir",
  ]),
  TopicCluster: Object.freeze([
    "clusterId",
    "memberRecordIds",
    "currentCandidateIds",
    "preferredCandidateId",
    "selectionAuthority",
  ]),
  ContextPack: Object.freeze([
    "contextPackId",
    "consumer",
    "effectiveScope",
    "basedOnRecordIds",
    "currentFacts",
    "warnings",
    "evidenceRefs",
    "generatedAt",
  ]),
  ConsumerProjection: Object.freeze([
    "consumer",
    "recordId",
    "effectiveScope",
    "lifecycleStatus",
    "sourceRefs",
    "evidenceRefs",
    "routeHint",
    "routeEvidenceRefs",
    "routeDerivedByMimir",
  ]),
  ArchiveManifest: Object.freeze([
    "archiveRef",
    "recordId",
    "previousLifecycleStatus",
    "reason",
    "sourceRef",
    "contentHash",
    "evidenceRefs",
    "supersededBy",
    "restorable",
  ]),
  LineageEdge: Object.freeze([
    "edgeId",
    "type",
    "fromId",
    "toId",
    "evidenceRefs",
    "createdAt",
  ]),
  ReturnEnvelope: Object.freeze([
    "returnId",
    "workId",
    "checkpointId",
    "source",
    "receivedAt",
    "items",
  ]),
  HousekeepingPlan: Object.freeze([
    "planId",
    "returnId",
    "workId",
    "checkpointId",
    "decisions",
    "compactRequired",
    "reindexRequired",
    "deleteCandidateIds",
    "requiresOwnerApproval",
    "writePerformed",
    "sourceMutationAllowed",
  ]),
});

const LIFECYCLE_SET = new Set(LIFECYCLE_STATUS);
const DUPLICATE_SET = new Set(DUPLICATE_STATE);
const LINEAGE_SET = new Set(LINEAGE_EDGE_TYPES);
const CONSUMER_SET = new Set(CONSUMERS);
const RETURN_ITEM_KIND_SET = new Set(RETURN_ITEM_KINDS);
const VISIBILITY_RANK = Object.freeze({ public: 0, internal: 1, restricted: 2, private: 3 });

function text(value, label, { optional = false } = {}) {
  const result = String(value ?? "").trim();
  if (!result && !optional) throw new Error(`${label} is required`);
  return result || null;
}

function iso(value, label, { optional = false } = {}) {
  const result = text(value, label, { optional });
  if (result === null) return null;
  if (Number.isNaN(new Date(result).getTime())) throw new Error(`${label} must be an ISO date`);
  return result;
}

function list(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = [...new Set(value.map(item => String(item ?? "").trim()).filter(Boolean))];
  if (!result.length && !optional) throw new Error(`${label} must not be empty`);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneJson(value) {
  if (value === undefined) return null;
  return value === null ? null : JSON.parse(JSON.stringify(value));
}

function normalizeConsumer(value) {
  const result = String(value ?? "").trim().toUpperCase();
  if (!CONSUMER_SET.has(result)) throw new Error(`unsupported consumer: ${result || "UNKNOWN"}`);
  return result;
}

export function normalizeAccessScope(scope = {}) {
  const allowedConsumers = list(scope.allowedConsumers, "accessScope.allowedConsumers", { optional: true }) ?? [];
  const normalizedConsumers = [...new Set(allowedConsumers.map(normalizeConsumer))];
  const fields = list(scope.fields, "accessScope.fields", { optional: true });
  const visibility = String(scope.visibility ?? "internal").trim().toLowerCase();
  if (!Object.hasOwn(VISIBILITY_RANK, visibility)) throw new Error(`unsupported access visibility: ${visibility}`);
  return deepFreeze({
    visibility,
    allowedConsumers: normalizedConsumers,
    fields,
  });
}

export function intersectAccessScopes(scopes = []) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return normalizeAccessScope({ visibility: "private", allowedConsumers: [] });
  }
  const normalized = scopes.map(normalizeAccessScope);
  let allowedConsumers = [...normalized[0].allowedConsumers];
  for (const scope of normalized.slice(1)) {
    allowedConsumers = allowedConsumers.filter(consumer => scope.allowedConsumers.includes(consumer));
  }

  let fields = normalized[0].fields ? [...normalized[0].fields] : null;
  for (const scope of normalized.slice(1)) {
    if (fields === null) fields = scope.fields ? [...scope.fields] : null;
    else if (scope.fields) fields = fields.filter(field => scope.fields.includes(field));
  }

  const visibility = normalized.reduce(
    (mostRestrictive, scope) => VISIBILITY_RANK[scope.visibility] > VISIBILITY_RANK[mostRestrictive]
      ? scope.visibility
      : mostRestrictive,
    "public",
  );
  return normalizeAccessScope({ visibility, allowedConsumers, fields });
}

export function createObservationEnvelope(input = {}) {
  const source = input.source ?? {};
  const sourceRef = text(source.sourceRef, "source.sourceRef");
  const evidenceRefs = list(input.evidenceRefs ?? [sourceRef], "evidenceRefs");
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    observationId: text(input.observationId, "observationId"),
    source: deepFreeze({
      system: text(source.system, "source.system"),
      sourceRef,
      sourceType: text(source.sourceType, "source.sourceType"),
      ownerRef: text(source.ownerRef, "source.ownerRef", { optional: true }),
      authorityHint: text(source.authorityHint, "source.authorityHint", { optional: true }),
    }),
    capturedAt: iso(input.capturedAt, "capturedAt"),
    observedAt: iso(input.observedAt, "observedAt"),
    schemaVersionAtSource: text(input.schemaVersion, "schemaVersion", { optional: true }),
    content: deepFreeze(cloneJson(input.content ?? {})),
    evidenceRefs,
    accessScope: normalizeAccessScope(input.accessScope),
    environment: deepFreeze({
      mode: String(input.environment?.mode ?? "unknown").trim().toLowerCase(),
      externalEffect: input.environment?.externalEffect === true,
    }),
  });
}

export function classifyLifecycle(input = {}, options = {}) {
  const policy = options.freshnessPolicy ?? {};
  const policyRef = text(policy.freshnessPolicyRef, "freshnessPolicyRef");
  const freshnessWindowMs = Number(policy.freshnessWindowMs);
  if (!Number.isFinite(freshnessWindowMs) || freshnessWindowMs <= 0) {
    throw new Error("freshnessWindowMs must be a positive number from external policy");
  }

  const observedAt = new Date(iso(input.observedAt, "observedAt")).getTime();
  const now = new Date(iso(options.now ?? new Date().toISOString(), "now")).getTime();
  const ageMs = Math.max(0, now - observedAt);
  const evidenceRefs = Array.isArray(input.evidenceRefs) ? input.evidenceRefs.filter(Boolean) : [];
  const smoke = input.isSmoke === true
    || ["test", "fixture", "seed", "sample", "demo", "smoke", "lab", "draft"].includes(String(input.environment?.mode ?? "").toLowerCase())
    || input.environment?.externalEffect === false && input.environment?.isSmoke === true;

  let lifecycleStatus = "unknown";
  let reason = "insufficient_evidence";
  if (input.quarantine === true) {
    lifecycleStatus = "quarantine";
    reason = "intake_quarantine";
  } else if (input.restricted === true || !input.accessScope?.allowedConsumers?.length) {
    lifecycleStatus = "restricted";
    reason = "scope_restricted";
  } else if (input.conflict === true) {
    lifecycleStatus = "conflict";
    reason = "unresolved_conflict";
  } else if (smoke) {
    lifecycleStatus = "smoke";
    reason = "test_or_non_production_marker";
  } else if (input.superseded === true || input.archived === true || input.explicitLifecycle === "legacy") {
    lifecycleStatus = "legacy";
    reason = "owner_or_source_marked_legacy";
  } else if (ageMs > freshnessWindowMs) {
    lifecycleStatus = "stale";
    reason = "outside_external_freshness_window";
  } else if (input.sourceAvailable !== false && input.schemaValid !== false && evidenceRefs.length > 0) {
    lifecycleStatus = "current";
    reason = "evidence_available_within_external_policy_window";
  }

  return deepFreeze({
    lifecycleStatus,
    reason,
    freshnessPolicyRef: policyRef,
    freshnessWindowMs,
    ageMs,
    freshnessConfidence: input.observedAt && policyRef ? 1 : 0,
    classificationConfidence: lifecycleStatus === "unknown" ? 0 : 1,
  });
}

export function relateDuplicate(left = {}, right = {}) {
  if (left.contentHash && right.contentHash && left.contentHash === right.contentHash) return "exact";
  if (left.identityKey && right.identityKey && left.identityKey === right.identityKey) return "identity";
  if (left.semanticKey && right.semanticKey && left.semanticKey === right.semanticKey) return "possible";
  return "none";
}

export function createCanonicalRecord(input = {}) {
  const observation = input.observation ?? {};
  const classification = input.classification ?? {};
  const lifecycleStatus = input.lifecycleStatus ?? classification.lifecycleStatus ?? "unknown";
  if (!LIFECYCLE_SET.has(lifecycleStatus)) throw new Error(`unsupported lifecycleStatus: ${lifecycleStatus}`);
  const duplicateState = input.duplicateState ?? "none";
  if (!DUPLICATE_SET.has(duplicateState)) throw new Error(`unsupported duplicateState: ${duplicateState}`);

  const truthOwner = text(input.truthOwner ?? observation.source?.ownerRef, "truthOwner");
  if (truthOwner.toUpperCase() === "MIMIR") throw new Error("truthOwner cannot be MIMIR");
  if (input.canMutateSource === true) throw new Error("MIMIR cannot mutate source");

  const routeHint = text(input.routeHint, "routeHint", { optional: true });
  const routeEvidenceRefs = list(input.routeEvidenceRefs, "routeEvidenceRefs", { optional: true }) ?? [];
  if (routeHint && routeEvidenceRefs.length === 0) throw new Error("routeHint requires routeEvidenceRefs");
  if (input.routeDerivedByMimir === true) throw new Error("MIMIR cannot derive route");

  const sourceRefs = list(input.sourceRefs ?? [observation.source?.sourceRef], "sourceRefs");
  const evidenceRefs = list(input.evidenceRefs ?? observation.evidenceRefs, "evidenceRefs");
  const accessScope = normalizeAccessScope(input.accessScope ?? observation.accessScope);
  const confidence = {
    identityConfidence: Number.isFinite(input.identityConfidence) ? input.identityConfidence : 0,
    freshnessConfidence: Number.isFinite(input.freshnessConfidence) ? input.freshnessConfidence : (classification.freshnessConfidence ?? 0),
    classificationConfidence: Number.isFinite(input.classificationConfidence) ? input.classificationConfidence : (classification.classificationConfidence ?? 0),
  };
  for (const [key, value] of Object.entries(confidence)) {
    if (value < 0 || value > 1) throw new Error(`${key} must be between 0 and 1`);
  }

  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    recordId: text(input.recordId, "recordId"),
    canonicalKey: text(input.canonicalKey, "canonicalKey"),
    recordType: text(input.recordType, "recordType"),
    title: text(input.title, "title"),
    summary: text(input.summary, "summary", { optional: true }),
    lifecycleStatus,
    duplicateState,
    confidence,
    sourceRefs,
    evidenceRefs,
    accessScope,
    lineage: deepFreeze({
      observedFrom: list(input.lineage?.observedFrom, "lineage.observedFrom", { optional: true }) ?? [observation.observationId].filter(Boolean),
      normalizedFrom: list(input.lineage?.normalizedFrom, "lineage.normalizedFrom", { optional: true }) ?? [],
      duplicateOf: list(input.lineage?.duplicateOf, "lineage.duplicateOf", { optional: true }) ?? [],
      supersedes: text(input.lineage?.supersedes, "lineage.supersedes", { optional: true }),
      supersededBy: text(input.lineage?.supersededBy, "lineage.supersededBy", { optional: true }),
    }),
    truthOwner,
    mimirRole: "derived_index",
    canMutateSource: false,
    routeHint,
    routeEvidenceRefs,
    routeDerivedByMimir: false,
    lastObservedAt: iso(input.lastObservedAt ?? observation.observedAt, "lastObservedAt"),
  });
}

export function buildTopicCluster(input = {}) {
  const records = Array.isArray(input.records) ? input.records : [];
  const conflict = records.some(record => record.lifecycleStatus === "conflict");
  const currentCandidateIds = conflict
    ? []
    : records.filter(record => record.lifecycleStatus === "current").map(record => record.recordId);
  const ownerPreferred = text(input.ownerPreferredCandidateId, "ownerPreferredCandidateId", { optional: true });
  const preferredCandidateId = !conflict && ownerPreferred && currentCandidateIds.includes(ownerPreferred)
    ? ownerPreferred
    : null;

  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    clusterId: text(input.clusterId, "clusterId"),
    canonicalTopic: text(input.canonicalTopic, "canonicalTopic"),
    memberRecordIds: records.map(record => record.recordId),
    currentCandidateIds,
    preferredCandidateId,
    selectionAuthority: "source_owner",
    autoCurrentSelection: false,
    hasConflict: conflict,
  });
}

export function createContextPack(input = {}) {
  const consumer = normalizeConsumer(input.consumer);
  const records = Array.isArray(input.records) ? input.records : [];
  const accessible = records.filter(record => record.accessScope.allowedConsumers.includes(consumer));
  const currentFacts = accessible
    .filter(record => record.lifecycleStatus === "current")
    .map(record => record.summary || record.title);
  const warnings = accessible
    .filter(record => ["stale", "legacy", "smoke", "conflict", "unknown"].includes(record.lifecycleStatus))
    .map(record => `${record.recordId}:${record.lifecycleStatus}`);
  const effectiveScope = intersectAccessScopes(accessible.map(record => record.accessScope));
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    contextPackId: text(input.contextPackId, "contextPackId"),
    consumer,
    effectiveScope,
    basedOnRecordIds: accessible.map(record => record.recordId),
    currentFacts,
    warnings,
    evidenceRefs: [...new Set(accessible.flatMap(record => record.evidenceRefs))],
    generatedAt: iso(input.generatedAt ?? new Date().toISOString(), "generatedAt"),
    routeHint: null,
    routeEvidenceRefs: [],
    routeDerivedByMimir: false,
  });
}

export function projectForConsumer(record, consumer) {
  const normalizedConsumer = normalizeConsumer(consumer);
  const allowed = record.accessScope.allowedConsumers.includes(normalizedConsumer);
  const effectiveScope = allowed
    ? normalizeAccessScope({
      visibility: record.accessScope.visibility,
      allowedConsumers: [normalizedConsumer],
      fields: record.accessScope.fields,
    })
    : normalizeAccessScope({ visibility: "restricted", allowedConsumers: [] });
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    consumer: normalizedConsumer,
    recordId: record.recordId,
    effectiveScope,
    lifecycleStatus: allowed ? record.lifecycleStatus : "restricted",
    sourceRefs: allowed ? record.sourceRefs : [],
    evidenceRefs: allowed ? record.evidenceRefs : [],
    routeHint: allowed ? record.routeHint : null,
    routeEvidenceRefs: allowed ? record.routeEvidenceRefs : [],
    routeDerivedByMimir: false,
  });
}

export function createLineageEdge(input = {}) {
  const type = text(input.type, "lineage edge type");
  if (!LINEAGE_SET.has(type)) throw new Error(`unsupported lineage edge type: ${type}`);
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    edgeId: text(input.edgeId, "edgeId"),
    type,
    fromId: text(input.fromId, "fromId"),
    toId: text(input.toId, "toId"),
    evidenceRefs: list(input.evidenceRefs, "evidenceRefs"),
    createdAt: iso(input.createdAt ?? new Date().toISOString(), "createdAt"),
  });
}

export function createArchiveManifest(input = {}) {
  const record = input.record ?? {};
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    archiveRef: text(input.archiveRef, "archiveRef"),
    recordId: text(record.recordId, "record.recordId"),
    previousLifecycleStatus: text(record.lifecycleStatus, "record.lifecycleStatus"),
    reason: text(input.reason, "reason"),
    archivedAt: iso(input.archivedAt ?? new Date().toISOString(), "archivedAt"),
    sourceRef: text(record.sourceRefs?.[0], "record.sourceRef"),
    contentHash: text(input.contentHash, "contentHash"),
    evidenceRefs: list(input.evidenceRefs ?? record.evidenceRefs, "evidenceRefs"),
    supersededBy: text(input.supersededBy, "supersededBy", { optional: true }),
    restorable: true,
  });
}


function normalizeReturnItem(item = {}, index = 0) {
  const kind = String(item.kind ?? "").trim().toUpperCase();
  if (!RETURN_ITEM_KIND_SET.has(kind)) throw new Error(`unsupported return item kind: ${kind || "UNKNOWN"}`);
  const lifecycleStatus = String(item.lifecycleStatus ?? "unknown").trim().toLowerCase();
  if (!LIFECYCLE_SET.has(lifecycleStatus)) throw new Error(`unsupported lifecycleStatus: ${lifecycleStatus}`);
  return deepFreeze({
    itemId: text(item.itemId ?? `return-item-${index + 1}`, "return item id"),
    kind,
    ref: text(item.ref, "return item ref"),
    lifecycleStatus,
    duplicateState: DUPLICATE_SET.has(String(item.duplicateState ?? "none").toLowerCase())
      ? String(item.duplicateState ?? "none").toLowerCase()
      : "none",
    duplicateOf: text(item.duplicateOf, "return item duplicateOf", { optional: true }),
    contentHash: text(item.contentHash, "return item contentHash", { optional: true }),
    evidenceRefs: list(item.evidenceRefs, "return item evidenceRefs", { optional: true }) ?? [],
    lineageRefs: list(item.lineageRefs, "return item lineageRefs", { optional: true }) ?? [],
    disposable: item.disposable === true,
    protected: item.protected === true || ["EVIDENCE", "RECEIPT"].includes(kind),
    payload: deepFreeze(cloneJson(item.payload ?? null)),
  });
}

export function createReturnEnvelope(input = {}) {
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new Error("return items must not be empty");
  }
  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    returnId: text(input.returnId, "returnId"),
    workId: text(input.workId, "workId"),
    checkpointId: text(input.checkpointId, "checkpointId"),
    source: text(input.source, "source"),
    receivedAt: iso(input.receivedAt ?? new Date().toISOString(), "receivedAt"),
    items: input.items.map(normalizeReturnItem),
  });
}

export function planReturnHousekeeping(input = {}) {
  const envelope = input.returnEnvelope ?? {};
  if (!Array.isArray(envelope.items) || envelope.items.length === 0) {
    throw new Error("returnEnvelope.items must not be empty");
  }
  const allowDeleteCandidates = input.policy?.allowDeleteCandidates === true;
  const policyRef = text(input.policy?.policyRef, "housekeeping policyRef");
  const decisions = envelope.items.map(item => {
    let action = "STORE";
    let reason = "current_or_preserved";

    if (item.lifecycleStatus === "conflict" || item.lifecycleStatus === "quarantine") {
      action = "QUARANTINE";
      reason = "conflict_or_quarantine";
    } else if (["stale", "legacy", "smoke"].includes(item.lifecycleStatus) || item.duplicateState !== "none") {
      const deletionSafe = allowDeleteCandidates
        && item.disposable === true
        && item.protected !== true
        && item.evidenceRefs.length === 0
        && item.lineageRefs.length === 0;
      if (deletionSafe) {
        action = "DELETE_CANDIDATE";
        reason = "policy_allows_disposable_unreferenced_item";
      } else {
        action = "ARCHIVE";
        reason = item.duplicateState !== "none" ? "duplicate_preserve_lineage" : "non_current_preserve_lineage";
      }
    } else if (item.lifecycleStatus === "unknown" || item.lifecycleStatus === "restricted") {
      action = "QUARANTINE";
      reason = "insufficient_or_restricted_truth";
    }

    return deepFreeze({
      itemId: item.itemId,
      kind: item.kind,
      ref: item.ref,
      lifecycleStatus: item.lifecycleStatus,
      duplicateState: item.duplicateState,
      action,
      reason,
      protected: item.protected,
    });
  });

  const deleteCandidateIds = decisions.filter(d => d.action === "DELETE_CANDIDATE").map(d => d.itemId);
  const compactRequired = decisions.some(d => ["ARCHIVE", "DELETE_CANDIDATE"].includes(d.action));
  const reindexRequired = compactRequired || envelope.items.some(item => item.duplicateState !== "none");

  return deepFreeze({
    schemaVersion: MIMIR_LOGIC_VERSION,
    planId: text(input.planId, "planId"),
    returnId: text(envelope.returnId, "returnEnvelope.returnId"),
    workId: text(envelope.workId, "returnEnvelope.workId"),
    checkpointId: text(envelope.checkpointId, "returnEnvelope.checkpointId"),
    policyRef,
    decisions,
    compactRequired,
    reindexRequired,
    deleteCandidateIds,
    requiresOwnerApproval: deleteCandidateIds.length > 0,
    writePerformed: false,
    sourceMutationAllowed: false,
    report: deepFreeze({
      received: decisions.length,
      store: decisions.filter(d => d.action === "STORE").length,
      archive: decisions.filter(d => d.action === "ARCHIVE").length,
      quarantine: decisions.filter(d => d.action === "QUARANTINE").length,
      deleteCandidate: deleteCandidateIds.length,
    }),
  });
}

export function assertMimirHousekeepingSafety(plan = {}) {
  if (plan.writePerformed === true) throw new Error("MIMIR housekeeping plan cannot perform writes");
  if (plan.sourceMutationAllowed === true) throw new Error("MIMIR housekeeping cannot mutate source");
  const decisions = Array.isArray(plan.decisions) ? plan.decisions : [];
  for (const decision of decisions) {
    if (decision.protected === true && decision.action === "DELETE_CANDIDATE") {
      throw new Error("protected return item cannot be a delete candidate");
    }
  }
  if ((plan.deleteCandidateIds?.length ?? 0) > 0 && plan.requiresOwnerApproval !== true) {
    throw new Error("delete candidates require owner approval");
  }
  return true;
}

export function assertMimirSafety(value = {}) {
  if (String(value.truthOwner ?? "").toUpperCase() === "MIMIR") throw new Error("truthOwner cannot be MIMIR");
  if (value.canMutateSource === true) throw new Error("MIMIR cannot mutate source");
  if (value.routeDerivedByMimir === true) throw new Error("MIMIR cannot derive route");
  if (value.lifecycleStatus === "conflict" && value.preferredCandidateId) {
    throw new Error("conflicted cluster cannot have preferredCandidateId");
  }
  return true;
}
