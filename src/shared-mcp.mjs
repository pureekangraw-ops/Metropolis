import { createHermesReception } from './agents/hermes/station-reception.mjs';
import { inspectWorkPass, workPassAllowsHandoff } from './work-pass.mjs';
const ACTIONS = ['read','handoff','return','cancel','complete'];
const RECEPTION_ACTIONS = ['input_information', 'review', 'ready_to_create', 'create_work', 'ready_to_resume', 'search_work', 'resume_work', 'cancel'];
const PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const string = { type: 'string', minLength: 1 };
const oauthSecurity = Object.freeze([{ type: 'oauth2', scopes: [] }]);
const profileOutputSchema = Object.freeze({
  '$schema': 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    id: { type: 'string', minLength: 1, pattern: '\\S', description: 'Stable opaque Metropolis profile identifier.' },
    name: { type: 'string', description: 'Authenticated Metropolis actor name.' },
    nickname: { type: 'string', description: 'Human-readable connection label.' },
  },
  required: ['id'],
  additionalProperties: false,
});
const actionSchemas = {
  read:{type:'object',properties:{},additionalProperties:false},
  handoff:{type:'object',properties:{stationId:string,operation:string,payload:{type:'object'}},required:['stationId','operation'],additionalProperties:false},
  return:{type:'object',properties:{readback:{type:'object'},evidenceRefs:{type:'array',items:string},updates:{type:'array',items:{type:'object',properties:{kind:string,valueRef:string,note:string},additionalProperties:false}},stationReviewed:{type:'boolean'}},additionalProperties:false},
  cancel:{type:'object',properties:{},additionalProperties:false},
  complete:{type:'object',properties:{},additionalProperties:false},
};

const receptionActionSchemas = {
  input_information: {
    type: 'object',
    properties: {
      information: { type: 'object' },
      inputRefs: { type: 'array', items: string },
      ownerSystem: string,
    },
    additionalProperties: false,
  },
  review: { type: 'object', properties: {}, additionalProperties: false },
  ready_to_create: { type: 'object', properties: {}, additionalProperties: false },
  create_work: { type: 'object', properties: {}, additionalProperties: false },
  ready_to_resume: { type: 'object', properties: {}, additionalProperties: false },
  search_work: {
    type: 'object',
    properties: { query: string, limit: { type: 'integer', minimum: 1, maximum: 25 } },
    required: ['query'],
    additionalProperties: false,
  },
  resume_work: {
    type: 'object',
    properties: { workId: string },
    required: ['workId'],
    additionalProperties: false,
  },
  cancel: {
    type: 'object',
    properties: {
      targetKind: { type: 'string', enum: ['DRAFT'] },
      targetId: string,
    },
    required: ['targetKind', 'targetId'],
    additionalProperties: false,
  },
};

function actionInputVariant(action, payloadSchema, {
  includeWorkId = false,
  includeDraftId = false,
  requireDraftId = false,
  requirePayload = false,
} = {}) {
  const properties = {
    action: { type: 'string', const: action },
    ...(includeWorkId ? { workId: string } : {}),
    ...(includeDraftId ? { draftId: string } : {}),
    payload: payloadSchema,
  };
  const required = ['action', ...(includeWorkId ? ['workId'] : []), ...(requireDraftId ? ['draftId'] : []), ...(requirePayload ? ['payload'] : [])];
  return { type: 'object', properties, required, additionalProperties: false };
}

const workInputSchema = Object.freeze({
  type: 'object',
  oneOf: ACTIONS.map(action => actionInputVariant(action, actionSchemas[action], {
    includeWorkId: true,
    requirePayload: action === 'handoff',
  })),
});

const receptionInputSchema = Object.freeze({
  type: 'object',
  oneOf: RECEPTION_ACTIONS.map(action => actionInputVariant(action, receptionActionSchemas[action], {
    includeDraftId: action !== 'cancel',
    requireDraftId: !['input_information', 'cancel'].includes(action),
    requirePayload: ['search_work', 'resume_work', 'cancel'].includes(action),
  })),
});

const tools = [
  {
    name: 'metropolis_identity',
    title: 'Metropolis identity',
    description: 'Return the GO or LIGHT profile represented by the authenticated connection. Use this to distinguish multiple connected Metropolis accounts.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: profileOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
    _meta: { 'openai/profile': true },
  },
  {
    name: 'metropolis_arrive',
    title: 'Enter Metropolis',
    description: 'GO/LIGHT arrival station. Refresh the current release/schema and return authorized Work/Checkpoint pointers on every arrival or refresh. No Work or authority is created.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
  {
    name: 'metropolis_reception',
    title: 'Use HERMES Reception',
    description: 'Capture intake information as a Draft Tablet, review it, then CREATE a new Work ID or SEARCH and RESUME an existing Work. HERMES cancels Drafts only; Work CANCEL/COMPLETE belongs to MIMIR through metropolis_work.',
    inputSchema: receptionInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
  {
    name: 'metropolis_work',
    title: 'Use Existing Metropolis Work',
    description: 'Operate on existing Work. Station RETURN records OUT and asks GO to review returned items; MIMIR organizes the reviewed packet. CANCEL/COMPLETE are MIMIR lifecycle actions.',
    inputSchema: workInputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
];

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
}
export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + '_REQUIRED');
  return value.trim();
}
function schemaMatches(value, schema) {
  if (!schema || typeof schema !== 'object') return true;
  if (Array.isArray(schema.oneOf)) {
    return schema.oneOf.filter(candidate => schemaMatches(value, candidate)).length === 1;
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (schema.type === 'string') {
    return typeof value === 'string' && (schema.minLength == null || value.length >= schema.minLength);
  }
  if (schema.type === 'integer') {
    return Number.isInteger(value)
      && (schema.minimum == null || value >= schema.minimum)
      && (schema.maximum == null || value <= schema.maximum);
  }
  if (schema.type === 'array') {
    return Array.isArray(value) && value.every(item => schemaMatches(item, schema.items));
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const properties = schema.properties || {};
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(properties, key))) return false;
    return Object.entries(properties).every(([key, child]) => !Object.hasOwn(value, key) || schemaMatches(value[key], child));
  }
  return true;
}
function toolResult(data, isError = false, meta = null) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError, ...(meta ? { _meta: meta } : {}) };
}
const PROFILE_IDS = Object.freeze({ GO: 'prf_7b65c803a1184c26', LIGHT: 'prf_d25e4e4fa31a42bc' });
const WORK_PASS_POLICY = 'PERSISTED_WORK_PASS_V1';
function explicitWorkGrants(grants, actor, workId) {
  return grants.filter(grant => grant.actor === actor && grant.workId === workId);
}
function passActions(record, actor) {
  return inspectWorkPass(record?.workPass, {
    workId: record?.workId,
    checkpointId: record?.checkpointId,
    actor,
    workState: record?.state,
  }).actions;
}
function destinationAllowed(record, actor, explicit, payload = {}) {
  if (explicit.length > 0) {
    return explicit.some(grant => grant.action === 'handoff'
      && (grant.stationId === '*' || grant.stationId === payload.stationId)
      && (grant.operation === '*' || grant.operation === payload.operation));
  }
  return workPassAllowsHandoff(record?.workPass, {
    workId: record?.workId,
    checkpointId: record?.checkpointId,
    actor,
    workState: record?.state,
    stationId: payload.stationId,
  });
}
function authChallenge(url) {
  return `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Link a GO or LIGHT Metropolis account to continue"`;
}

export function createMetropolisMcp({ runtime, authenticate, grants = [], sourceSha = 'UNKNOWN', version = '1.0.0', allowedOrigins = [] } = {}) {
  if (!runtime || typeof authenticate !== 'function') throw new Error('RUNTIME_AUTHENTICATOR_REQUIRED');
  async function manifest(actor) {
    const authorizedActions = grants.filter(g => g.actor === actor);
    const schemaHash = await hash(JSON.stringify({ tools, actionSchemas, receptionActionSchemas, version, sourceSha, actor, grants: authorizedActions, workPassPolicy: WORK_PASS_POLICY }));
    const observedAt = new Date().toISOString();
    const listed = typeof runtime.listWorks === 'function' ? await runtime.listWorks() : [];
    const passIds = listed
      .filter(record => record?.workId && passActions(record, actor).length > 0)
      .map(record => record.workId);
    const workIds = [...new Set([...authorizedActions.map(grant => grant.workId), ...passIds])];
    const works = await Promise.all(workIds.map(async workId => {
      try {
        const record = await runtime.getWork(workId);
        const explicit = explicitWorkGrants(grants, actor, workId);
        const actions = record ? (explicit.length > 0 ? explicit.map(grant => grant.action) : passActions(record, actor)) : explicit.map(grant => grant.action);
        if (!record) return { workId, present: false, state: 'UNKNOWN', checkpointId: null, ownerSystem: null, updatedAt: null, authorizedActions: actions };
        return {
          workId,
          present: true,
          state: record.state || 'UNKNOWN',
          checkpointId: record.checkpointId || null,
          ownerSystem: record.ownerSystem || null,
          updatedAt: record.updatedAt || null,
          authorizedActions: [...new Set(actions)],
          accessSource: explicit.length > 0 ? 'EXPLICIT_POLICY' : 'PERSISTED_WORK_PASS',
          workPassRef: record.workPassRef || null,
          tablet: record.tablet || null,
          online: record.online || null,
          latestJourney: Array.isArray(record.journeys) && record.journeys.length ? record.journeys.at(-1) : null,
        };
      } catch {
        return { workId, present: null, state: 'UNKNOWN', checkpointId: null, ownerSystem: null, updatedAt: null, authorizedActions: authorizedActions.filter(grant => grant.workId === workId).map(grant => grant.action), reason: 'CURRENT_READ_FAILED' };
      }
    }));
    return {
      service: 'METROPOLIS',
      station: 'AGENT_ARRIVAL_STATION',
      actor,
      version,
      sourceSha,
      schemaHash,
      observedAt,
      tools,
      actionSchemas,
      receptionActionSchemas,
      policy: { mode: WORK_PASS_POLICY, workAccessRules: authorizedActions },
      current: {
        release: { version, sourceSha },
        schema: { schemaHash, refreshedAt: observedAt, mode: 'FRESH_ON_ARRIVAL' },
        works,
        onlineWorks: works.filter(work => work.present === true && work.online?.status === 'ONLINE'),
      },
      reception: createHermesReception({ actor, works, observedAt }),
      refresh: { mode: 'READ_CURRENT_ON_EVERY_CALL', transportNotificationSupported: false, clientReconnectMayBeRequired: true, currentSnapshotIncluded: true },
      authorityCreated: false,
      workCreated: false,
    };
  }
  async function call(name, args, actor) {
    const current = await manifest(actor);
    if (name === 'metropolis_identity') {
      const profile = { id: PROFILE_IDS[actor], name: actor, nickname: `${actor} — Metropolis` };
      return toolResult(profile);
    }
    if (name === 'metropolis_arrive') return toolResult(current);
    if (name === 'metropolis_reception') {
      try {
        if (!['GO', 'LIGHT'].includes(actor)) return toolResult({ reason: 'NO_RECEPTION_AUTHORITY' }, true);
        const action = required(args.action, 'action');
        if (!RECEPTION_ACTIONS.includes(action)) throw new Error('ACTION_NOT_FOUND');
        if (!schemaMatches(args, receptionInputSchema)) throw new Error('INVALID_ARGUMENT');
        const payload = args.payload || {};

        let result;
        if (action === 'input_information') {
          result = await runtime.reception.inputInformation({
            actor,
            draftId: args.draftId,
            information: payload.information || {},
            inputRefs: payload.inputRefs || [],
            ownerSystem: payload.ownerSystem ?? null,
          });
        } else if (action === 'review') {
          result = await runtime.reception.review({ actor, draftId: args.draftId });
        } else if (action === 'ready_to_create') {
          result = await runtime.reception.ready({ actor, draftId: args.draftId, decision: 'READY_TO_CREATE' });
        } else if (action === 'create_work') {
          result = await runtime.reception.create({ actor, draftId: args.draftId });
        } else if (action === 'ready_to_resume') {
          result = await runtime.reception.ready({ actor, draftId: args.draftId, decision: 'READY_TO_RESUME' });
        } else if (action === 'search_work') {
          result = await runtime.reception.search({ actor, draftId: args.draftId, query: payload.query, limit: payload.limit });
        } else if (action === 'resume_work') {
          result = await runtime.reception.resume({ actor, draftId: args.draftId, workId: payload.workId });
        } else if (action === 'cancel') {
          result = await runtime.reception.cancel({ actor, targetKind: payload.targetKind, targetId: payload.targetId });
        }

        return toolResult({ actor, action, result });
      } catch (error) {
        const known = /^(.*_REQUIRED|DRAFT_[A-Z0-9_]+|READY_[A-Z0-9_]+|OWNER_SYSTEM_REQUIRED|INFORMATION_INVALID|INPUT_REFS_INVALID|SEARCH_QUERY_REQUIRED|WORK_NOT_FOUND|WORK_CANCELLED|WORK_CLOSED|WORK_CLOSURE_BELONGS_TO_MIMIR|CANCEL_[A-Z0-9_]+|INVALID_ARGUMENT|INVALID_PAYLOAD|ACTION_NOT_FOUND)$/;
        return toolResult({ reason: known.test(error.message) ? error.message : 'RECEPTION_OPERATION_FAILED' }, true);
      }
    }
    if (name !== 'metropolis_work') return toolResult({ reason: 'TOOL_NOT_FOUND' }, true);
    try {
      const action = required(args.action, 'action');
      const workId = required(args.workId, 'workId');
      if (!ACTIONS.includes(action)) throw new Error('ACTION_NOT_FOUND');
      if (!schemaMatches(args, workInputSchema)) throw new Error('INVALID_ARGUMENT');
      const payload = args.payload || {};
      const before = await runtime.getWork(workId);
      if (!before) throw new Error('WORK_NOT_FOUND');
      const explicit = explicitWorkGrants(grants, actor, workId);
      const allowedActions = explicit.length > 0
        ? explicit.map(grant => grant.action)
        : passActions(before, actor);
      if (!allowedActions.includes(action)) return toolResult({ reason: 'NO_GRANT' }, true);
      let record;
      if (action === 'read') record = before;
      else if (action === 'handoff') {
        if (!destinationAllowed(before, actor, explicit, payload)) throw new Error('DESTINATION_NOT_GRANTED');
        record = await runtime.handoff({ workId, checkpointId: before.checkpointId, actor, stationId: payload.stationId, operation: payload.operation, payload: payload.payload || {} });
      } else if (action === 'return') {
        // Agent-supplied flags cannot declare verified owner reality.
        record = await runtime.returnWork({
          workId,
          checkpointId: before.checkpointId,
          actor,
          readback: payload.readback,
          evidenceRefs: payload.evidenceRefs || [],
          updates: payload.updates || [],
          stationReviewed: payload.stationReviewed === true,
        });
      } else if (action === 'cancel') {
        record = await runtime.cancelWork({ workId, actor:'MIMIR', requestedBy:actor });
      } else if (action === 'complete') {
        record = await runtime.completeWork({ workId, actor:'MIMIR', requestedBy:actor });
      } else throw new Error('ACTION_NOT_FOUND');
      const readback = await runtime.getWork(workId);
      if (JSON.stringify(record) !== JSON.stringify(readback)) throw new Error('WRITE_READBACK_MISMATCH');
      const ownerExecutionVerified = action === 'handoff'
        ? readback?.handoff?.external?.verified === true
        : action === 'return'
          ? readback?.return?.verified === true
          : false;
      return toolResult({ actor, record: readback, readbackVerified: true, ownerExecutionVerified });
    } catch (error) {
      const known = /^(.*_REQUIRED|WORK_NOT_FOUND|WORK_ALREADY_EXISTS|WORK_NOT_ONLINE|WORK_CANCELLED|INVALID_ARGUMENT|INVALID_PAYLOAD|OWNER_NOT_GRANTED|DESTINATION_NOT_GRANTED|ACTION_NOT_FOUND|WRITE_READBACK_MISMATCH|FACTORY_[A-Z0-9_]+)$/;
      return toolResult({ reason: known.test(error.message) ? error.message : 'WORK_OPERATION_FAILED' }, true);
    }
  }
  return Object.freeze({ async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return json({ reason: 'ROUTE_NOT_FOUND' }, 404);
    const origin = request.headers.get('origin');
    if (origin && !allowedOrigins.includes(origin)) return json({ reason: 'ORIGIN_DENIED' }, 403);
    if (request.method !== 'POST') return json({ reason: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ reason: 'CONTENT_TYPE_REQUIRED' }, 415);
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return json({ reason: 'ACCEPT_REQUIRED' }, 406);
    const protocol = request.headers.get('mcp-protocol-version');
    if (protocol && !PROTOCOLS.includes(protocol)) return json({ reason: 'PROTOCOL_NOT_SUPPORTED' }, 400);

    let body;
    try {
      const raw = await request.text();
      if (raw.length > 65536) return json({ reason: 'REQUEST_TOO_LARGE' }, 413);
      body = JSON.parse(raw);
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
    }
    if (!Object.hasOwn(body, 'id')) {
      return body.method.startsWith('notifications/') ? new Response(null, { status: 202 }) : json({ reason: 'INVALID_NOTIFICATION' }, 400);
    }

    const reply = result => json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') {
      if (!PROTOCOLS.includes(body.params?.protocolVersion)) {
        return json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unsupported protocol version' } }, 400);
      }
      return reply({
        protocolVersion: body.params.protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'metropolis', version },
        instructions: 'List tools, link a GO or LIGHT Metropolis account, then call metropolis_arrive. New work starts at HERMES Reception as INPUT INFORMATION → DRAFT → REVIEW → READY TO CREATE → CREATE WORK. Resume uses READY TO RESUME → SEARCH WORK → RESUME WORK. Work IDs are created by City Hall, not by callers.',
      });
    }
    if (body.method === 'ping') return reply({});
    if (body.method === 'tools/list') return reply({ tools });

    if (body.method === 'tools/call') {
      let principal;
      try { principal = await authenticate(request); } catch { /* tool-level auth challenge below */ }
      if (!['GO', 'LIGHT'].includes(principal?.actor)) {
        return reply(toolResult(
          { reason: 'AUTH_REQUIRED' },
          true,
          { 'mcp/www_authenticate': [authChallenge(url)] },
        ));
      }
      return reply(await call(body.params?.name, body.params?.arguments || {}, principal.actor));
    }

    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  } });
}
