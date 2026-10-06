const ACTIONS = ['read', 'intake', 'handoff', 'return'];
const PROTOCOLS = ['2025-03-26', '2025-06-18', '2025-11-25'];
const string = { type: 'string', minLength: 1 };
const tools = [
  { name: 'metropolis_arrive', description: 'GO/LIGHT arrival station. Read current release, schema hash, schemas and authorized actions on every arrival or refresh. No Work or authority is created.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'metropolis_work', description: 'Use existing City Hall Work operations with authenticated identity and current schemaHash. Refresh at metropolis_arrive when SCHEMA_REFRESH_REQUIRED. Never self-declare actor or permissions.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ACTIONS }, workId: string, checkpointId: string, schemaHash: string, payload: { type: 'object' } }, required: ['action', 'workId', 'checkpointId', 'schemaHash'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
const actionSchemas = {
  read: { type: 'object', properties: {}, additionalProperties: false },
  intake: { type: 'object', properties: { ownerSystem: string, inputRefs: { type: 'array', items: string } }, required: ['ownerSystem'], additionalProperties: false },
  handoff: { type: 'object', properties: { stationId: string, railId: string, operation: string, payload: { type: 'object' } }, required: ['stationId', 'railId', 'operation'], additionalProperties: false },
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
function toolResult(data, isError = false) { return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError }; }

export function createMetropolisMcp({ runtime, authenticate, grants = [], sourceSha = 'UNKNOWN', version = '1.0.0', allowedOrigins = [] } = {}) {
  if (!runtime || typeof authenticate !== 'function') throw new Error('RUNTIME_AUTHENTICATOR_REQUIRED');
  async function manifest(actor) {
    const schemaHash = await hash(JSON.stringify({ tools, actionSchemas, version, sourceSha, actor, grants: grants.filter(g => g.actor === actor) }));
    return { service: 'METROPOLIS', station: 'AGENT_ARRIVAL_STATION', actor, version, sourceSha, schemaHash, observedAt: new Date().toISOString(), tools, actionSchemas, authorizedActions: grants.filter(g => g.actor === actor), refresh: { mode: 'READ_CURRENT_ON_EVERY_CALL', transportNotificationSupported: false, clientReconnectMayBeRequired: true }, authorityCreated: false, workCreated: false };
  }
  async function call(name, args, actor) {
    const current = await manifest(actor);
    if (name === 'metropolis_arrive') return toolResult(current);
    if (name !== 'metropolis_work') return toolResult({ reason: 'TOOL_NOT_FOUND' }, true);
    if (args.schemaHash !== current.schemaHash) return toolResult({ reason: 'SCHEMA_REFRESH_REQUIRED', current }, true);
    try {
      const action = required(args.action, 'action');
      const workId = required(args.workId, 'workId');
      const checkpointId = required(args.checkpointId, 'checkpointId');
      const payload = args.payload || {};
      const grant = grants.find(g => g.actor === actor && g.action === action && g.workId === workId);
      if (!grant) return toolResult({ reason: 'NO_GRANT' }, true);
      if (Object.keys(args).some(k => !['action', 'workId', 'checkpointId', 'schemaHash', 'payload'].includes(k))) throw new Error('INVALID_ARGUMENT');
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_PAYLOAD');
      if (payload.inputRefs && (!Array.isArray(payload.inputRefs) || payload.inputRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      if (payload.evidenceRefs && (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.some(v => typeof v !== 'string'))) throw new Error('INVALID_PAYLOAD');
      let before = await runtime.getWork(workId);
      if (action !== 'intake') {
        if (!before) throw new Error('WORK_NOT_FOUND');
        if (before.checkpointId !== checkpointId) throw new Error('CHECKPOINT_MISMATCH');
      }
      let record;
      if (action === 'read') record = before;
      else if (action === 'intake') {
        if (grant.ownerSystem !== payload.ownerSystem) throw new Error('OWNER_NOT_GRANTED');
        record = await runtime.intake({ workId, checkpointId, ownerSystem: payload.ownerSystem, requestedBy: actor, inputRefs: payload.inputRefs || [] });
      } else if (action === 'handoff') {
        if (grant.stationId !== payload.stationId || grant.railId !== payload.railId || grant.operation !== payload.operation) throw new Error('DESTINATION_NOT_GRANTED');
        record = await runtime.handoff({ workId, checkpointId, actor, stationId: payload.stationId, railId: payload.railId, operation: payload.operation, payload: payload.payload || {} });
      } else if (action === 'return') {
        // Agent-supplied flags cannot declare verified owner reality.
        record = await runtime.returnWork({ workId, checkpointId, actor, readback: payload.readback, evidenceRefs: payload.evidenceRefs || [], verified: false });
      } else throw new Error('ACTION_NOT_FOUND');
      const readback = await runtime.getWork(workId);
      if (JSON.stringify(record) !== JSON.stringify(readback)) throw new Error('WRITE_READBACK_MISMATCH');
      return toolResult({ actor, schemaHash: current.schemaHash, record: readback, readbackVerified: true, ownerExecutionVerified: false });
    } catch (error) {
      const known = /^(.*_REQUIRED|WORK_NOT_FOUND|WORK_ALREADY_EXISTS|CHECKPOINT_MISMATCH|INVALID_ARGUMENT|INVALID_PAYLOAD|OWNER_NOT_GRANTED|DESTINATION_NOT_GRANTED|ACTION_NOT_FOUND|WRITE_READBACK_MISMATCH)$/;
      return toolResult({ reason: known.test(error.message) ? error.message : 'WORK_OPERATION_FAILED' }, true);
    }
  }
  return Object.freeze({ async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/mcp') return json({ reason: 'ROUTE_NOT_FOUND' }, 404);
    const origin = request.headers.get('origin');
    if (origin && !allowedOrigins.includes(origin)) return json({ reason: 'ORIGIN_DENIED' }, 403);
    let principal;
    try { principal = await authenticate(request); } catch { /* fail closed */ }
    if (!['GO', 'LIGHT'].includes(principal?.actor)) return json({ reason: 'AUTH_REQUIRED' }, 401, { 'www-authenticate': `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp"` });
    if (request.method !== 'POST') return json({ reason: 'METHOD_NOT_ALLOWED' }, 405, { allow: 'POST' });
    if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ reason: 'CONTENT_TYPE_REQUIRED' }, 415);
    const accept = request.headers.get('accept') || '';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) return json({ reason: 'ACCEPT_REQUIRED' }, 406);
    const protocol = request.headers.get('mcp-protocol-version');
    if (protocol && !PROTOCOLS.includes(protocol)) return json({ reason: 'PROTOCOL_NOT_SUPPORTED' }, 400);
    let body;
    try { const raw = await request.text(); if (raw.length > 65536) return json({ reason: 'REQUEST_TOO_LARGE' }, 413); body = JSON.parse(raw); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } }, 400);
    if (!Object.hasOwn(body, 'id')) return body.method.startsWith('notifications/') ? new Response(null, { status: 202 }) : json({ reason: 'INVALID_NOTIFICATION' }, 400);
    const reply = result => json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'initialize') {
      if (!PROTOCOLS.includes(body.params?.protocolVersion)) return json({ jsonrpc: '2.0', id: body.id, error: { code: -32602, message: 'Unsupported protocol version' } }, 400);
      return reply({ protocolVersion: body.params.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'metropolis', version }, instructions: 'Call metropolis_arrive on entry/resume to read CURRENT version and schemas. Use the returned schemaHash on every Work call. GO and LIGHT share this endpoint; authentication determines actor.' });
    }
    if (body.method === 'ping') return reply({});
    if (body.method === 'tools/list') return reply({ tools });
    if (body.method === 'tools/call') return reply(await call(body.params?.name, body.params?.arguments || {}, principal.actor));
    return json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Method not found' } });
  } });
}
