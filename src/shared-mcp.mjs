const ACTIONS = ['read', 'intake', 'handoff', 'return'];
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
    name: 'metropolis_work',
    title: 'Use Metropolis Work',
    description: 'Use existing City Hall Work operations with authenticated identity. The server owns current checkpoint, schema context and granted owner/destination details; callers provide only the Work, action and action payload.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS }, workId: string, payload: { type: 'object' } }, required: ['action', 'workId'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    securitySchemes: oauthSecurity,
  },
];
const actionSchemas = {
  read: { type: 'object', properties: {}, additionalProperties: false },
  intake: { type: 'object', properties: { inputRefs: { type: 'array', items: string } }, additionalProperties: false },
  handoff: { type: 'object', properties: { stationId: string, operation: string, payload: { type: 'object' } }, required: ['stationId', 'operation'], additionalProperties: false },
  return: { type: 'object', properties: { readback: { type: 'object' }, evidenceRefs: { type: 'array', items: string } }, additionalProperties: false },
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

export function createMetropolisMcp({ runtime, authenticate, grants = [], sourceSha = 'UNKNOWN', version = '1.0.0', allowedOrigins = [], grantsProvider = async () => [], stationHandler } = {}) {
  if (!runtime || typeof authenticate !== 'function') throw new Error('RUNTIME_AUTHENTICATOR_REQUIRED');
  async function manifest(actor) {
    const authorizedActions = [...grants, ...await grantsProvider(actor)].filter(g => g.actor === actor);
    const schemaHash = await hash(JSON.stringify({ tools, actionSchemas, version, sourceSha, actor, grants: authorizedActions }));
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
      authorizedActions,
      current: {
        release: { version, sourceSha },
        schema: { schemaHash, refreshedAt: observedAt, mode: 'FRESH_ON_ARRIVAL' },
        works,
      },
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
    if (name !== 'metropolis_work') return toolResult({ reason: 'TOOL_NOT_FOUND' }, true);
    try {
      const action = required(args.action, 'action');
      const workId = required(args.workId, 'workId');
      const payload = args.payload || {};
      const matchingGrants = current.authorizedActions.filter(g => g.actor === actor && g.action === action && g.workId === workId);
      if (matchingGrants.length === 0) return toolResult({ reason: 'NO_GRANT' }, true);
      if (Object.keys(args).some(k => !['action', 'workId', 'payload'].includes(k))) throw new Error('INVALID_ARGUMENT');
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
      if (payload.inputRefs && (!Array.isArray(payload.inputRefs) || payload.inputRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      if (payload.evidenceRefs && (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      const before = await runtime.getWork(workId);
      if (action !== 'intake' && !before) throw new Error('WORK_NOT_FOUND');
      let record, stationResult;
      if (action === 'read') record = before;
      else if (action === 'intake') {
        const grant = matchingGrants.find(g => typeof g.ownerSystem === 'string' && g.ownerSystem.trim() !== '');
        if (!grant) throw new Error('OWNER_NOT_GRANTED');
        record = await runtime.intake({ workId, ownerSystem: grant.ownerSystem, requestedBy: actor, inputRefs: payload.inputRefs || [] });
      } else if (action === 'handoff') {
        const grant = matchingGrants.find(g => g.stationId === payload.stationId && g.operation === payload.operation);
        if (!grant) throw new Error('DESTINATION_NOT_GRANTED');
        if (payload.stationId === 'OBSERVATORY_STATION') {
          if (!stationHandler) throw new Error('STATION_UNAVAILABLE');
          stationResult = await stationHandler({ actor, workId, checkpointId: before.checkpointId, operation: payload.operation, payload: payload.payload || {} });
          // Durable station results contain observations; Work stores only bounded correlation pointers.
          record = await runtime.handoff({workId, checkpointId:before.checkpointId, actor, stationId:payload.stationId, operation:payload.operation, payload:{deviceId:payload.payload?.deviceId,view:payload.payload?.view,commandId:stationResult.commandId||null}});
        } else record = await runtime.handoff({ workId, checkpointId: before.checkpointId, actor, stationId: payload.stationId, operation: payload.operation, payload: payload.payload || {} });
      } else if (action === 'return') {
        // Agent-supplied flags cannot declare verified owner reality.
        record = await runtime.returnWork({ workId, checkpointId: before.checkpointId, actor, readback: payload.readback, evidenceRefs: payload.evidenceRefs || [], verified: false });
      } else throw new Error('ACTION_NOT_FOUND');
      const readback = await runtime.getWork(workId);
      if (JSON.stringify(record) !== JSON.stringify(readback)) throw new Error('WRITE_READBACK_MISMATCH');
      const ownerExecutionVerified = action === 'handoff'
        ? readback?.handoff?.external?.verified === true
        : action === 'return'
          ? readback?.return?.verified === true
          : false;
      return toolResult({ actor, record: readback, readbackVerified: true, ownerExecutionVerified, ...(stationResult ? {stationResult} : {}) });
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
        instructions: 'List tools, link a GO or LIGHT Metropolis account, then call metropolis_arrive on entry/resume. Metropolis keeps current Work checkpoint and schema context server-side; callers do not echo internal IDs.',
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
