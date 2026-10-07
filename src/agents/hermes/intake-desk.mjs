export const HERMES_INTAKE_FLOW = Object.freeze({
  stages: Object.freeze(['INPUT_INFORMATION', 'DRAFT', 'REVIEW']),
  decisions: Object.freeze(['READY_TO_CREATE', 'READY_TO_RESUME']),
  commands: Object.freeze({
    READY_TO_CREATE: Object.freeze(['CREATE_WORK']),
    READY_TO_RESUME: Object.freeze(['SEARCH_WORK', 'RESUME_WORK']),
    CANCEL: Object.freeze(['CANCEL', 'SELECT_TARGET']),
  }),
  workIdRule: 'WORK_ID_IS_CREATED_ONLY_BY_CREATE_WORK',
  resumeRule: 'RESUME_KEEPS_EXISTING_WORK_ID_AND_LATEST_CHECKPOINT',
  cancelRule: 'CANCEL_SELECTS_THE_TARGET_AFTER_THE_COMMAND',
  securityRule: 'POLICY_IS_ENFORCED_BEHIND_THE_FLOW_NOT_USED_AS_HERMES_NAVIGATION',
});

export const INTAKE_STATE = Object.freeze({
  DRAFT: 'DRAFT',
  REVIEW: 'REVIEW',
  READY_TO_CREATE: 'READY_TO_CREATE',
  READY_TO_RESUME: 'READY_TO_RESUME',
  WORK_CREATED: 'WORK_CREATED',
  WORK_RESUMED: 'WORK_RESUMED',
  CANCELLED: 'CANCELLED',
});

const text = value => String(value ?? '').trim();
const clone = value => value == null ? value : structuredClone(value);

function assertActor(record, actor) {
  if (record?.createdBy !== text(actor)) throw new Error('DRAFT_ACTOR_MISMATCH');
}

function assertMutable(record) {
  if (!record) throw new Error('DRAFT_NOT_FOUND');
  if (record.state === INTAKE_STATE.CANCELLED) throw new Error('DRAFT_CANCELLED');
  if ([INTAKE_STATE.WORK_CREATED, INTAKE_STATE.WORK_RESUMED].includes(record.state)) throw new Error('DRAFT_ALREADY_CONVERTED');
}

function searchableWork(record = {}) {
  return [
    record.workId,
    record.checkpointId,
    record.ownerSystem,
    record.intake?.draftId,
    record.intake?.title,
    record.intake?.summary,
  ].filter(Boolean).join(' ').toLowerCase();
}

export function createHermesIntakeDesk({
  store,
  tabletRuntime,
  createWork,
  getWork,
  listWorks,
  cancelWork,
  clock = () => new Date().toISOString(),
  idFactory = () => crypto.randomUUID(),
} = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.put !== 'function') throw new Error('INTAKE_STORE_REQUIRED');
  if (typeof createWork !== 'function' || typeof getWork !== 'function' || typeof listWorks !== 'function' || typeof cancelWork !== 'function') {
    throw new Error('WORK_RUNTIME_REQUIRED');
  }

  async function persistDraft(record, actor = 'HERMES') {
    const base = { ...record, updatedAt: clock() };
    await store.put(`intake:${base.draftId}`, base);
    let tabletDraft = null;
    if (tabletRuntime?.saveDraft) {
      try {
        tabletDraft = await tabletRuntime.saveDraft(base, { actor: 'HERMES' });
      } catch (error) {
        tabletDraft = {
          status: 'UNKNOWN',
          verified: false,
          reason: 'TABLET_DRAFT_SAVE_FAILED',
          errorCode: error?.message || 'UNKNOWN',
        };
      }
    }
    const next = { ...base, tabletDraft: clone(tabletDraft), updatedAt: clock() };
    await store.put(`intake:${next.draftId}`, next);
    return clone(next);
  }

  async function inputInformation({
    actor,
    draftId,
    information = {},
    inputRefs = [],
    ownerSystem = null,
  } = {}) {
    const who = text(actor);
    if (!who) throw new Error('ACTOR_REQUIRED');
    if (!information || typeof information !== 'object' || Array.isArray(information)) throw new Error('INFORMATION_INVALID');
    if (!Array.isArray(inputRefs) || inputRefs.some(ref => typeof ref !== 'string' || !ref.trim())) throw new Error('INPUT_REFS_INVALID');

    const id = text(draftId) || `DRAFT-${idFactory()}`;
    const previous = await store.get(`intake:${id}`);
    if (previous) {
      assertActor(previous, who);
      assertMutable(previous);
    }

    const now = clock();
    const mergedRefs = [...new Set([...(previous?.inputRefs || []), ...inputRefs.map(ref => ref.trim())])];
    const record = {
      kind: 'INTAKE_DRAFT',
      draftId: id,
      createdBy: previous?.createdBy || who,
      state: INTAKE_STATE.DRAFT,
      information: { ...(previous?.information || {}), ...clone(information) },
      inputRefs: mergedRefs,
      ownerSystem: ownerSystem == null ? (previous?.ownerSystem || null) : text(ownerSystem),
      decision: null,
      review: null,
      workId: null,
      checkpointId: null,
      createdAt: previous?.createdAt || now,
      updatedAt: now,
      ownsWorkTruth: false,
      workCreated: false,
    };
    return persistDraft(record, who);
  }

  async function review({ actor, draftId } = {}) {
    const id = text(draftId);
    if (!id) throw new Error('DRAFT_ID_REQUIRED');
    const record = await store.get(`intake:${id}`);
    assertMutable(record);
    assertActor(record, actor);

    const informationPresent = Object.keys(record.information || {}).length > 0 || (record.inputRefs || []).length > 0;
    const issues = informationPresent ? [] : ['INFORMATION_REQUIRED'];
    const next = {
      ...record,
      state: INTAKE_STATE.REVIEW,
      review: {
        status: issues.length === 0 ? 'READY_FOR_DECISION' : 'NEEDS_INFORMATION',
        issues,
        reviewedAt: clock(),
      },
      decision: null,
    };
    return persistDraft(next, actor);
  }

  async function ready({ actor, draftId, decision } = {}) {
    const id = text(draftId);
    const selected = text(decision);
    if (!id) throw new Error('DRAFT_ID_REQUIRED');
    if (![INTAKE_STATE.READY_TO_CREATE, INTAKE_STATE.READY_TO_RESUME].includes(selected)) throw new Error('READY_DECISION_INVALID');
    const record = await store.get(`intake:${id}`);
    assertMutable(record);
    assertActor(record, actor);
    if (record.state !== INTAKE_STATE.REVIEW || record.review?.status !== 'READY_FOR_DECISION') throw new Error('REVIEW_REQUIRED');
    if (selected === INTAKE_STATE.READY_TO_CREATE && !text(record.ownerSystem)) throw new Error('OWNER_SYSTEM_REQUIRED');

    return persistDraft({
      ...record,
      state: selected,
      decision: selected,
    }, actor);
  }

  async function create({ actor, draftId } = {}) {
    const id = text(draftId);
    if (!id) throw new Error('DRAFT_ID_REQUIRED');
    const draft = await store.get(`intake:${id}`);
    assertMutable(draft);
    assertActor(draft, actor);
    if (draft.state !== INTAKE_STATE.READY_TO_CREATE) throw new Error('READY_TO_CREATE_REQUIRED');

    const workId = `WORK-${idFactory()}`;
    const record = await createWork({
      workId,
      ownerSystem: draft.ownerSystem,
      requestedBy: text(actor),
      inputRefs: [...(draft.inputRefs || [])],
      intakeDraftId: draft.draftId,
      intakeInformation: clone(draft.information || {}),
    });

    const sealed = await persistDraft({
      ...draft,
      state: INTAKE_STATE.WORK_CREATED,
      workId: record.workId,
      checkpointId: record.checkpointId,
      workCreated: true,
      convertedAt: clock(),
    }, actor);

    return Object.freeze({
      status: 'WORK_CREATED',
      draft: sealed,
      work: clone(record),
      workId: record.workId,
      checkpointId: record.checkpointId,
      go: true,
    });
  }

  async function search({ actor, draftId, query, limit = 10 } = {}) {
    const who = text(actor);
    const intakeId = text(draftId);
    if (!who) throw new Error('ACTOR_REQUIRED');
    if (!intakeId) throw new Error('DRAFT_ID_REQUIRED');
    const draft = await store.get(`intake:${intakeId}`);
    assertMutable(draft);
    assertActor(draft, who);
    if (draft.state !== INTAKE_STATE.READY_TO_RESUME) throw new Error('READY_TO_RESUME_REQUIRED');

    const q = text(query).toLowerCase();
    if (!q) throw new Error('SEARCH_QUERY_REQUIRED');
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 10, 25));
    const records = await listWorks();
    const matches = records
      .filter(record => record && record.kind === 'WORK_RECORD')
      .filter(record => searchableWork(record).includes(q))
      .slice(0, boundedLimit)
      .map(record => ({
        workId: record.workId,
        checkpointId: record.checkpointId,
        state: record.state,
        ownerSystem: record.ownerSystem,
        title: record.intake?.title || null,
        summary: record.intake?.summary || null,
        updatedAt: record.updatedAt || null,
      }));
    return Object.freeze({
      draftId: intakeId,
      query: text(query),
      matches: Object.freeze(matches),
      count: matches.length,
      workTruthChanged: false,
    });
  }

  async function resume({ actor, draftId, workId } = {}) {
    const who = text(actor);
    const intakeId = text(draftId);
    if (!who) throw new Error('ACTOR_REQUIRED');
    if (!intakeId) throw new Error('DRAFT_ID_REQUIRED');
    const draft = await store.get(`intake:${intakeId}`);
    assertMutable(draft);
    assertActor(draft, who);
    if (draft.state !== INTAKE_STATE.READY_TO_RESUME) throw new Error('READY_TO_RESUME_REQUIRED');

    const id = text(workId);
    if (!id) throw new Error('WORK_ID_REQUIRED');
    const record = await getWork(id);
    if (!record) throw new Error('WORK_NOT_FOUND');
    if (record.state === 'CANCELLED') throw new Error('WORK_CANCELLED');

    const resumedDraft = await persistDraft({
      ...draft,
      state: INTAKE_STATE.WORK_RESUMED,
      workId: record.workId,
      checkpointId: record.checkpointId,
      workCreated: false,
      resumedAt: clock(),
    }, who);

    return Object.freeze({
      status: 'WORK_RESUMED',
      draft: resumedDraft,
      workId: record.workId,
      checkpointId: record.checkpointId,
      state: record.state,
      ownerSystem: record.ownerSystem,
      tablet: clone(record.tablet || null),
      workTruthChanged: false,
      rule: HERMES_INTAKE_FLOW.resumeRule,
      go: true,
    });
  }

  async function cancel({ actor, targetKind, targetId } = {}) {
    const who = text(actor);
    const kind = text(targetKind).toUpperCase();
    const id = text(targetId);
    if (!who) throw new Error('ACTOR_REQUIRED');
    if (!['DRAFT', 'WORK'].includes(kind)) throw new Error('CANCEL_TARGET_KIND_INVALID');
    if (!id) throw new Error('CANCEL_TARGET_ID_REQUIRED');

    if (kind === 'DRAFT') {
      const record = await store.get(`intake:${id}`);
      assertMutable(record);
      assertActor(record, who);
      const cancelled = await persistDraft({
        ...record,
        state: INTAKE_STATE.CANCELLED,
        decision: null,
        cancelledAt: clock(),
        cancelledBy: who,
      }, who);
      return Object.freeze({
        status: 'CANCELLED',
        targetKind: 'DRAFT',
        targetId: id,
        draft: cancelled,
      });
    }

    const work = await cancelWork({ workId: id, actor: who });
    return Object.freeze({
      status: 'CANCELLED',
      targetKind: 'WORK',
      targetId: id,
      work: clone(work),
    });
  }

  async function getDraft(draftId) {
    const id = text(draftId);
    if (!id) throw new Error('DRAFT_ID_REQUIRED');
    return clone(await store.get(`intake:${id}`));
  }

  return Object.freeze({
    flow: HERMES_INTAKE_FLOW,
    inputInformation,
    review,
    ready,
    create,
    search,
    resume,
    cancel,
    getDraft,
  });
}
