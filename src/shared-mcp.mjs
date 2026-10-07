import { createHermesReception } from './agents/hermes/station-reception.mjs';
const ACTIONS = ['read', 'handoff', 'return'];
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
    description: 'Capture intake information as a Draft Tablet, review it, then CREATE a new Work ID or SEARCH and RESUME an existing Work. CANCEL selects its target after the command. Work IDs are never caller-created.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: RECEPTION_ACTIONS },
        draftId: string,
        payload: { type: 'object' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
  {
    name: 'metropolis_work',
    title: 'Use Existing Metropolis Work',
    description: 'Operate on an existing City Hall Work. CREATE and RESUME belong to HERMES Reception; this tool never creates a caller-supplied Work ID.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS }, workId: string, payload: { type: 'object' } }, required: ['action', 'workId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
];
const actionSchemas = {
  read: { type: 'object', properties: {}, additionalProperties: false },
  handoff: { type: 'object', properties: { stationId: string, operation: string, payload: { type: 'object' } }, required: ['stationId', 'operation'], additionalProperties: false },
  return: {
    type: 'object',
    properties: {
      readback: { type: 'object' },
      evidenceRefs: { type: 'array', items: string },
      updates: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: string, valueRef: string, note: string },
          additionalProperties: false,
        },
      },
      confirmation: { type: 'string', enum: ['CONFIRM_RETURN'] },
    },
    additionalProperties: false,
  },
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
      targetKind: { type: 'string', enum: ['DRAFT', 'WORK'] },
      targetId: string,
    },
    required: ['targetKind', 'targetId'],
    additionalProperties: false,
  },
};
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
function toolResult(data, isError = false, meta = null) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError, ...(meta ? { _meta: meta } : {}) };
}
const PROFILE_IDS = Object.freeze({ GO: 'prf_7b65c803a1184c26', LIGHT: 'prf_d25e4e4fa31a42bc' });
function authChallenge(url) {
  return `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", error_description="Link a GO or LIGHT Metropolis account to continue"`;
}

export function createMetropolisMcp({ runtime, authenticate, grants = [], sourceSha = 'UNKNOWN', version = '1.0.0', allowedOrigins = [] } = {}) {
  if (!runtime || typeof authenticate !== 'function') throw new Error('RUNTIME_AUTHENTICATOR_REQUIRED');
  async function manifest(actor) {
    const authorizedActions = grants.filter(g => g.actor === actor);
    const schemaHash = await hash(JSON.stringify({ tools, actionSchemas, receptionActionSchemas, version, sourceSha, actor, grants: authorizedActions }));
    const observedAt = new Date().toISOString();
    const workIds = [...new Set(authorizedActions.map(grant => grant.workId))];
    const works = await Promise.all(workIds.map(async workId => {
      try {
        const record = await runtime.getWork(workId);
        if (!record) return { workId, present: false, state: 'UNKNOWN', checkpointId: null, ownerSystem: null, updatedAt: null, authorizedActions: authorizedActions.filter(grant => grant.workId === workId).map(grant => grant.action) };
        return {
          workId,
          present: true,
          state: record.state || 'UNKNOWN',
          checkpointId: record.checkpointId || null,
          ownerSystem: record.ownerSystem || null,
          updatedAt: record.updatedAt || null,
          authorizedActions: authorizedActions.filter(grant => grant.workId === workId).map(grant => grant.action),
          tablet: record.tablet || null,
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
      policy: { workAccessRules: authorizedActions },
      current: {
        release: { version, sourceSha },
        schema: { schemaHash, refreshedAt: observedAt, mode: 'FRESH_ON_ARRIVAL' },
        works,
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
        if (actor !== 'GO') return toolResult({ reason: 'NO_RECEPTION_AUTHORITY' }, true);
        const action = required(args.action, 'action');
        if (!RECEPTION_ACTIONS.includes(action)) throw new Error('ACTION_NOT_FOUND');
        if (Object.keys(args).some(key => !['action', 'draftId', 'payload'].includes(key))) throw new Error('INVALID_ARGUMENT');
        const payload = args.payload || {};
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');

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
        const known = /^(.*_REQUIRED|DRAFT_[A-Z0-9_]+|READY_[A-Z0-9_]+|OWNER_SYSTEM_REQUIRED|INFORMATION_INVALID|INPUT_REFS_INVALID|SEARCH_QUERY_REQUIRED|WORK_NOT_FOUND|WORK_CANCELLED|CANCEL_[A-Z0-9_]+|INVALID_ARGUMENT|INVALID_PAYLOAD|ACTION_NOT_FOUND)$/;
        return toolResult({ reason: known.test(error.message) ? error.message : 'RECEPTION_OPERATION_FAILED' }, true);
      }
    }
    if (name !== 'metropolis_work') return toolResult({ reason: 'TOOL_NOT_FOUND' }, true);
    try {
      const action = required(args.action, 'action');
      const workId = required(args.workId, 'workId');
      const payload = args.payload || {};
      const matchingGrants = grants.filter(g => g.actor === actor && g.action === action && g.workId === workId);
      if (matchingGrants.length === 0) return toolResult({ reason: 'NO_GRANT' }, true);
      if (Object.keys(args).some(k => !['action', 'workId', 'payload'].includes(k))) throw new Error('INVALID_ARGUMENT');
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
      if (payload.inputRefs && (!Array.isArray(payload.inputRefs) || payload.inputRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      if (payload.evidenceRefs && (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      if (payload.updates && (!Array.isArray(payload.updates) || payload.updates.some(v => !v || typeof v !== 'object' || Array.isArray(v)))) throw new Error('INVALID_PAYLOAD');
      if (payload.confirmation != null && payload.confirmation !== 'CONFIRM_RETURN') throw new Error('INVALID_PAYLOAD');
      const before = await runtime.getWork(workId);
      if (!before) throw new Error('WORK_NOT_FOUND');
      let record;
      if (action === 'read') record = before;
      else if (action === 'handoff') {
        const grant = matchingGrants.find(g => g.stationId === payload.stationId && g.operation === payload.operation);
        if (!grant) throw new Error('DESTINATION_NOT_GRANTED');
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
          confirmation: payload.confirmation || null,
          verified: false,
        });
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
      const known = /^(.*_REQUIRED|WORK_NOT_FOUND|WORK_ALREADY_EXISTS|INVALID_ARGUMENT|INVALID_PAYLOAD|OWNER_NOT_GRANTED|DESTINATION_NOT_GRANTED|ACTION_NOT_FOUND|WRITE_READBACK_MISMATCH|FACTORY_[A-Z0-9_]+)$/;
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
