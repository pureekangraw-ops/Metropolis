export const WORK_COMPLETION_CRITERIA_SCHEMA = 'WORK_COMPLETION_CRITERIA_V1';
export const WORK_COMPLETION_RESULT_STATUS = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);
export const WORK_REVIEW_TRIGGERS = Object.freeze([
  'RECOVERY',
  'ROLLBACK',
  'SCOPE_CHANGE',
  'CONFLICTING_EVIDENCE',
  'REPEATED_FAILURE',
  'SAFETY_SECURITY_IMPACT',
  'ACCEPTANCE_UNCLEAR',
  'CONTRACT_REVIEW_REQUIRED',
]);

const text = value => typeof value === 'string' ? value.trim() : '';
const unique = values => [...new Set(values)];
const clone = value => value == null ? value : structuredClone(value);

export function normalizeCompletionCriteria(value, { allowMissing = true } = {}) {
  if (value == null) {
    if (allowMissing) return null;
    throw new Error('COMPLETION_CRITERIA_REQUIRED');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('COMPLETION_CRITERIA_INVALID');
  }
  if (value.schema != null && value.schema !== WORK_COMPLETION_CRITERIA_SCHEMA) {
    throw new Error('COMPLETION_CRITERIA_SCHEMA_INVALID');
  }
  if (!Array.isArray(value.items) || value.items.length === 0) {
    throw new Error('COMPLETION_CRITERIA_ITEMS_REQUIRED');
  }
  const seen = new Set();
  const items = value.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('COMPLETION_CRITERION_INVALID');
    }
    const criterionId = text(item.criterionId);
    const description = text(item.description);
    if (!criterionId || !description) throw new Error('COMPLETION_CRITERION_FIELDS_REQUIRED');
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(criterionId)) {
      throw new Error('COMPLETION_CRITERION_ID_INVALID');
    }
    if (seen.has(criterionId)) throw new Error('COMPLETION_CRITERION_ID_DUPLICATE');
    seen.add(criterionId);
    if (item.independentReviewRequired != null && typeof item.independentReviewRequired !== 'boolean') {
      throw new Error('COMPLETION_CRITERION_REVIEW_FLAG_INVALID');
    }
    return Object.freeze({
      criterionId,
      description,
      independentReviewRequired: item.independentReviewRequired === true,
    });
  });
  return Object.freeze({
    schema: WORK_COMPLETION_CRITERIA_SCHEMA,
    items: Object.freeze(items),
  });
}

export function evaluateCompletionCriteria(criteriaValue, resultsValue, {
  assessedAt = new Date().toISOString(),
  assessedBy = 'MIMIR',
} = {}) {
  const criteria = normalizeCompletionCriteria(criteriaValue, { allowMissing: false });
  const results = Array.isArray(resultsValue) ? resultsValue : [];
  const byId = new Map();
  for (const result of results) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('COMPLETION_RESULT_INVALID');
    }
    const criterionId = text(result.criterionId);
    if (!criterionId || byId.has(criterionId)) throw new Error('COMPLETION_RESULT_ID_INVALID');
    if (!WORK_COMPLETION_RESULT_STATUS.includes(result.status)) {
      throw new Error('COMPLETION_RESULT_STATUS_INVALID');
    }
    if (result.evidenceRefs != null
      && (!Array.isArray(result.evidenceRefs)
        || result.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()))) {
      throw new Error('COMPLETION_EVIDENCE_REFS_INVALID');
    }
    byId.set(criterionId, {
      criterionId,
      status: result.status,
      evidenceRefs: unique((result.evidenceRefs || []).map(text).filter(Boolean)),
    });
  }
  const criterionIds = new Set(criteria.items.map(item => item.criterionId));
  if ([...byId.keys()].some(id => !criterionIds.has(id))) {
    throw new Error('COMPLETION_RESULT_UNKNOWN_CRITERION');
  }
  const checks = criteria.items.map(criterion => {
    const result = byId.get(criterion.criterionId);
    const status = result?.status || 'UNKNOWN';
    const evidenceRefs = result?.evidenceRefs || [];
    return {
      criterionId: criterion.criterionId,
      status: status === 'PASS' && evidenceRefs.length === 0 ? 'UNKNOWN' : status,
      evidenceRefs,
    };
  });
  const status = checks.every(item => item.status === 'PASS')
    ? 'PASS'
    : checks.some(item => item.status === 'FAIL')
      ? 'NOT_MET'
      : 'INCOMPLETE';
  return Object.freeze({
    schema: 'WORK_COMPLETION_CHECK_V1',
    status,
    checks: Object.freeze(checks.map(item => Object.freeze(item))),
    assessedAt,
    assessedBy,
  });
}

export function completionReviewTriggers(criteriaValue, readback, trustedVerified) {
  const triggers = [];
  let criteria = null;
  try {
    criteria = normalizeCompletionCriteria(criteriaValue, { allowMissing: false });
  } catch {
    triggers.push('ACCEPTANCE_UNCLEAR');
  }
  if (!trustedVerified) triggers.push('ACCEPTANCE_UNCLEAR');
  if (criteria?.items.some(item => item.independentReviewRequired)) {
    triggers.push('CONTRACT_REVIEW_REQUIRED');
  }
  const requested = readback?.reviewTriggers;
  if (Array.isArray(requested)) {
    for (const trigger of requested) {
      if (!WORK_REVIEW_TRIGGERS.includes(trigger)) throw new Error('REVIEW_TRIGGER_INVALID');
      triggers.push(trigger);
    }
  }
  return Object.freeze(unique(triggers));
}

export function completionCriteriaEvidence(results) {
  return unique((Array.isArray(results) ? results : [])
    .flatMap(result => Array.isArray(result?.evidenceRefs) ? result.evidenceRefs : [])
    .map(text)
    .filter(Boolean));
}

export function cloneCompletionCriteria(value) {
  return clone(value);
}