const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACTOR_SCOPES = Object.freeze({ GO: 'metropolis-go', LIGHT: 'metropolis-light' });

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function base64url(bytes) {
  const value = typeof bytes === 'string' ? encoder.encode(bytes) : bytes;
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64url(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

function timingSafeEqual(left, right) {
  const a = typeof left === 'string' ? encoder.encode(left) : left;
  const b = typeof right === 'string' ? encoder.encode(right) : right;
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  }
  return difference === 0;
}

async function signEnvelope(payload, signingKey) {
  const body = base64url(JSON.stringify(payload));
  return body + '.' + base64url(await hmac(body, signingKey));
}

async function verifyEnvelope(value, signingKey) {
  const [body, signature, extra] = String(value || '').split('.');
  if (!body || !signature || extra) throw new Error('invalid signed envelope');
  const expected = await hmac(body, signingKey);
  if (!timingSafeEqual(fromBase64url(signature), expected)) throw new Error('invalid signed envelope');
  return JSON.parse(decoder.decode(fromBase64url(body)));
}

async function sha256Base64url(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function allowedRedirectUris(config) {
  return [...new Set([
    config.redirectUri,
    ...(Array.isArray(config.redirectUris) ? config.redirectUris : []),
  ].map(value => String(value || '').trim()).filter(Boolean))];
}

function oauthClients(config) {
  const configuredClients = Array.isArray(config.clients) ? config.clients : [];
  const clients = configuredClients.length ? configuredClients : [{
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUris: allowedRedirectUris(config),
    subject: config.subject || 'big',
    scope: config.scope || 'go-hub',
  }];
  return clients.map(client => ({
    clientId: String(client?.clientId || '').trim(),
    clientSecret: String(client?.clientSecret || ''),
    redirectUris: [...new Set((Array.isArray(client?.redirectUris) ? client.redirectUris : [])
      .map(value => String(value || '').trim()).filter(Boolean))],
    resources: [...new Set((Array.isArray(client?.resources) ? client.resources : [])
      .map(value => String(value || '').trim()).filter(Boolean))],
    subject: String(client?.subject || 'big'),
    scope: String(client?.scope || 'go-hub'),
    kind: 'REGISTERED',
    tokenEndpointAuthMethod: 'client_secret_basic',
  })).filter(client => client.clientId && client.clientSecret && client.redirectUris.length);
}

function clientById(config, clientId) {
  return oauthClients(config).find(client => client.clientId === String(clientId || ''));
}

function actorIdentity(actor) {
  const subject = String(actor || '').trim().toUpperCase();
  const scope = ACTOR_SCOPES[subject];
  return scope ? { subject, scope } : null;
}

function identityFromRequestedScope(scope) {
  const requested = new Set(String(scope || '').split(/\s+/).map(value => value.trim()).filter(Boolean));
  const matches = Object.entries(ACTOR_SCOPES).filter(([, actorScope]) => requested.has(actorScope));
  return matches.length === 1 ? { subject: matches[0][0], scope: matches[0][1] } : null;
}

function validCimdClientId(value, config = {}) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash) return false;
    if (url.hostname === 'app.notion.com') return url.pathname === '/oauth/mcp-client-metadata.json';
    if (url.hostname === 'chatgpt.com') return /^\/oauth\/(?:client\.json|[^/]+\/client\.json)$/.test(url.pathname);
    return url.origin === String(config.issuer || '') && url.pathname === '/oauth/observatory-client.json';
  } catch {
    return false;
  }
}

const CHATGPT_CIMD_CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const CHATGPT_CIMD_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const NOTION_CIMD_CLIENT_ID = 'https://app.notion.com/oauth/mcp-client-metadata.json';
const NOTION_CIMD_REDIRECT_URI = 'https://app.notion.com/workflows/mcp/oauth/callback';
const OBSERVATORY_CIMD_PATH = '/oauth/observatory-client.json';
const OBSERVATORY_CIMD_REDIRECT_PATH = '/oauth/observatory-callback';

function knownCimdClient(config, clientId) {
  if (clientId === `${config.issuer}${OBSERVATORY_CIMD_PATH}`) {
    return {
      clientId,
      clientSecret: '',
      redirectUris: [`${config.issuer}${OBSERVATORY_CIMD_REDIRECT_PATH}`],
      resources: [defaultResource(config)],
      subject: 'GO',
      scope: ACTOR_SCOPES.GO,
      fixedIdentity: { subject: 'GO', scope: ACTOR_SCOPES.GO },
      kind: 'CIMD',
      tokenEndpointAuthMethod: 'none',
    };
  }
  // Pin the public client's published callback, as for ChatGPT, so authorization
  // does not depend on provider metadata being reachable from the Worker.
  const redirectUri = clientId === CHATGPT_CIMD_CLIENT_ID ? CHATGPT_CIMD_REDIRECT_URI
    : clientId === NOTION_CIMD_CLIENT_ID ? NOTION_CIMD_REDIRECT_URI : null;
  if (!redirectUri) return null;
  return {
    clientId,
    clientSecret: '',
    redirectUris: [redirectUri],
    resources: [defaultResource(config)],
    subject: null,
    scope: null,
    kind: 'CIMD',
    tokenEndpointAuthMethod: 'none',
  };
}

async function resolveCimdClient(config, clientId) {
  if (config.allowCimd !== true || !validCimdClientId(clientId, config)) return null;
  const known = knownCimdClient(config, clientId);
  if (known) return known;
  const fetchImpl = config.fetchImpl || fetch;
  let response;
  try {
    response = await fetchImpl(clientId, { headers: { accept: 'application/json' }, redirect: 'error' });
  } catch {
    return null;
  }
  if (!response?.ok) return null;
  let metadata;
  try { metadata = await response.json(); } catch { return null; }
  const redirectUris = Array.isArray(metadata?.redirect_uris)
    ? [...new Set(metadata.redirect_uris.map(value => String(value || '').trim()).filter(Boolean))]
    : [];
  const methods = Array.isArray(metadata?.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : [metadata?.token_endpoint_auth_method].filter(Boolean);
  const grants = Array.isArray(metadata?.grant_types) ? metadata.grant_types : [];
  const responses = Array.isArray(metadata?.response_types) ? metadata.response_types : [];
  if (metadata?.client_id !== clientId || !redirectUris.length || !methods.includes('none') || !grants.includes('authorization_code') || !responses.includes('code')) return null;
  return {
    clientId,
    clientSecret: '',
    redirectUris,
    resources: [defaultResource(config)],
    subject: null,
    scope: null,
    kind: 'CIMD',
    tokenEndpointAuthMethod: 'none',
  };
}

async function resolveClient(config, clientId) {
  return clientById(config, clientId) || await resolveCimdClient(config, clientId);
}

function configured(config) {
  return Boolean(
    config.issuer && config.signingKey && config.ownerPasscode &&
    (oauthClients(config).length || config.allowCimd === true) &&
    config.ledger?.consume && config.ledger?.blocked && config.ledger?.failure &&
    config.ledger?.refreshFamilyRevoked && config.ledger?.revokeRefreshFamily,
  );
}

function nowSeconds(config) {
  return Math.floor(Number(config.now ? config.now() : Date.now() / 1000));
}

function refreshTokenTtlSeconds(config) {
  const configuredTtl = Number(config.refreshTokenTtlSeconds);
  return Number.isFinite(configuredTtl)
    ? Math.max(3600, Math.floor(configuredTtl))
    : REFRESH_TOKEN_TTL_SECONDS;
}

function defaultResource(config) {
  return String(config.resource || (config.issuer + '/mcp'));
}

function allowedClientResources(config, client) {
  const resources = Array.isArray(client?.resources) ? client.resources.filter(Boolean) : [];
  return resources.length ? resources : [defaultResource(config)];
}

function resolveClientResource(config, client, value) {
  const fallback = defaultResource(config);
  const resource = String(value || '').trim() || fallback;
  if (!allowedClientResources(config, client).includes(resource)) throw new Error('invalid resource');
  return resource;
}

function protectedResourceForMetadata(config, _path) {
  return defaultResource(config);
}

function clientAllowsTokenIdentity(client, payload, config) {
  const delegated = Object.hasOwn(payload, 'act');
  if (delegated) {
    const ownerId = String(config.ownerId || '').trim();
    if (!ownerId || payload.sub !== ownerId || actorIdentity(payload.act)?.scope !== payload.scope) return false;
  }
  return clientAllowsIdentity(client, delegated ? payload.act : payload.sub, payload.scope);
}

function clientAllowsIdentity(client, subject, scope) {
  if (client?.kind === 'CIMD') {
    return client.fixedIdentity
      ? client.fixedIdentity.subject === subject && client.fixedIdentity.scope === scope
      : actorIdentity(subject)?.scope === scope;
  }
  return client?.subject === subject && client?.scope === scope;
}

async function validateAuthorize(input, config) {
  if (input.get('response_type') !== 'code') throw new Error('unsupported response type');
  const client = await resolveClient(config, input.get('client_id'));
  if (!client) throw new Error('invalid client');
  const redirectUri = String(input.get('redirect_uri') || '');
  if (!client.redirectUris.includes(redirectUri)) throw new Error('invalid redirect uri');
  if (input.get('code_challenge_method') !== 'S256') throw new Error('S256 PKCE is required');
  const challenge = String(input.get('code_challenge') || '');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error('invalid code challenge');
  const resource = resolveClientResource(config, client, input.get('resource'));
  const requestedScope = String(input.get('scope') || '');
  const fixedIdentity = client.fixedIdentity || (client.kind === 'REGISTERED'
    ? { subject: client.subject, scope: client.scope }
    : identityFromRequestedScope(requestedScope));
  if (client.kind === 'REGISTERED' || client.fixedIdentity) {
    const requestedActor = identityFromRequestedScope(requestedScope);
    if (requestedActor && requestedActor.subject !== fixedIdentity.subject) throw new Error('scope identity mismatch');
  }
  return {
    client,
    state: String(input.get('state') || ''),
    redirectUri,
    codeChallenge: challenge,
    resource,
    requestedScope,
    fixedIdentity,
  };
}

export async function createTestAuthorizationCode(config = {}) {
  const issuedAt = nowSeconds(config);
  return signEnvelope({
    type: 'code',
    jti: crypto.randomUUID(),
    iss: config.issuer,
    aud: config.clientId,
    sub: config.subject || 'big',
    ...(config.actor ? { act: config.actor } : {}),
    redirect_uri: config.redirectUri,
    code_challenge: config.codeChallenge,
    resource: config.resource || config.issuer + '/mcp',
    scope: config.scope || 'go-hub',
    iat: issuedAt,
    exp: config.expiresAt ?? issuedAt + 300,
  }, config.signingKey);
}

export async function createAccessToken(config = {}) {
  const issuedAt = nowSeconds(config);
  const ttlSeconds = Number.isFinite(Number(config.ttlSeconds))
    ? Math.max(60, Number(config.ttlSeconds))
    : ACCESS_TOKEN_TTL_SECONDS;
  return signEnvelope({
    type: 'access',
    iss: config.issuer,
    aud: config.resource || config.issuer + '/mcp',
    ...(config.clientId ? { client_id: String(config.clientId) } : {}),
    sub: config.subject || 'big',
    ...(config.actor ? { act: config.actor } : {}),
    scope: config.scope || 'go-hub',
    iat: issuedAt,
    exp: config.expiresAt ?? issuedAt + ttlSeconds,
  }, config.signingKey);
}

export async function createTestAccessToken(config = {}) {
  return createAccessToken(config);
}

export async function createTestRefreshToken(config = {}) {
  const issuedAt = nowSeconds(config);
  return signEnvelope({
    type: 'refresh',
    jti: crypto.randomUUID(),
    fid: config.familyId || crypto.randomUUID(),
    iss: config.issuer,
    aud: config.clientId,
    sub: config.subject || 'big',
    ...(config.actor ? { act: config.actor } : {}),
    resource: config.resource || config.issuer + '/mcp',
    scope: config.scope || 'go-hub',
    iat: issuedAt,
    exp: config.expiresAt ?? issuedAt + refreshTokenTtlSeconds(config),
  }, config.signingKey);
}

export async function verifyAccessToken(request, config = {}) {
  if (!config.issuer || !config.signingKey) throw new Error('OAuth is not configured');
  const authorization = String(request.headers.get('authorization') || '');
  if (!authorization.startsWith('Bearer ')) throw new Error('missing bearer token');
  const payload = await verifyEnvelope(authorization.slice(7), config.signingKey);
  const expectedResource = config.resource || config.issuer + '/mcp';
  const current = nowSeconds(config);
  if (payload.type !== 'access' || payload.iss !== config.issuer || payload.aud !== expectedResource || !Number.isFinite(payload.exp) || payload.exp <= current) {
    throw new Error('invalid access token');
  }
  if (Object.hasOwn(payload, 'act') && (!String(config.ownerId || '').trim() || payload.sub !== config.ownerId || actorIdentity(payload.act)?.scope !== payload.scope)) throw new Error('invalid delegated identity');
  const clientId = String(payload.client_id || '').trim();
  if (config.requireClientId === true && !clientId) throw new Error('invalid access token');
  const registered = oauthClients(config).find(client => client.clientId === clientId);
  const knownCimd = knownCimdClient(config, clientId);
  const cimdAllowed = config.allowCimd === true
    && validCimdClientId(clientId, config)
    && (knownCimd?.fixedIdentity
      ? clientAllowsTokenIdentity(knownCimd, payload, config)
      : actorIdentity(Object.hasOwn(payload, 'act') ? payload.act : payload.sub)?.scope === payload.scope);
  if (registered) {
    if (!clientAllowsTokenIdentity(registered, payload, config)) throw new Error('client identity mismatch');
  } else if (!cimdAllowed) {
    const acceptedClientIds = new Set([
      String(config.clientId || '').trim(),
      ...(Array.isArray(config.acceptedClientIds) ? config.acceptedClientIds : []),
    ].map(value => String(value || '').trim()).filter(Boolean));
    const acceptedIdentities = Array.isArray(config.acceptedIdentities) && config.acceptedIdentities.length
      ? config.acceptedIdentities.map(identity => String(identity?.subject || '') + '\u0000' + String(identity?.scope || ''))
      : [];
    if (!acceptedClientIds.has(clientId) || (acceptedIdentities.length && !acceptedIdentities.includes(String(Object.hasOwn(payload, 'act') ? payload.act : payload.sub) + '\u0000' + String(payload.scope)))) {
      throw new Error('invalid access token');
    }
  }
  return Object.hasOwn(payload, 'act')
    ? { subject: payload.sub, scope: payload.scope, owner: payload.sub, actor: payload.act, delegated: true }
    : { subject: payload.sub, scope: payload.scope };
}

function scopesForMetadata(config) {
  const scopes = new Set(oauthClients(config).map(client => client.scope));
  if (config.allowCimd === true) Object.values(ACTOR_SCOPES).forEach(scope => scopes.add(scope));
  return [...scopes];
}

function metadata(config, path) {
  if (path === '/.well-known/oauth-authorization-server') {
    const methods = [];
    if (config.allowCimd === true) methods.push('none');
    if (oauthClients(config).length) methods.push('client_secret_basic');
    return json({
      issuer: config.issuer,
      authorization_endpoint: config.issuer + '/oauth/authorize',
      token_endpoint: config.issuer + '/oauth/token',
      client_id_metadata_document_supported: config.allowCimd === true,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: methods,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: scopesForMetadata(config),
    });
  }
  const resource = protectedResourceForMetadata(config, path);
  return json({
    resource,
    authorization_servers: [config.issuer],
    scopes_supported: scopesForMetadata(config),
    bearer_methods_supported: ['header'],
  });
}

function observatoryClientMetadata(config) {
  const clientId = `${config.issuer}${OBSERVATORY_CIMD_PATH}`;
  const redirectUri = `${config.issuer}${OBSERVATORY_CIMD_REDIRECT_PATH}`;
  return json({
    client_id: clientId,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: ACTOR_SCOPES.GO,
  });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function authorizePage(values) {
  const hidden = Object.entries(values.hidden).map(([name, value]) =>
    `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
  ).join('');
  const identity = values.fixedIdentity
    ? `<input type="hidden" name="actor" value="${escapeHtml(values.fixedIdentity.subject)}"><p>Enter as <strong>${escapeHtml(values.fixedIdentity.subject)}</strong></p>`
    : '<label>Enter as <select name="actor" required><option value="GO">GO</option><option value="LIGHT">LIGHT</option></select></label>';
  const ownerNotice = values.ownerId
    ? `<p>Owner <strong>${escapeHtml(values.ownerId)}</strong> authorizes this agent to act on their behalf, within Metropolis policy.</p>`
    : '';
  return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Metropolis authorization</title><body><main><h1>Metropolis</h1><p>Authorize this Metropolis connection.</p>${ownerNotice}<form method="post">${hidden}${identity}<label>Owner passcode <input name="passcode" type="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form></main></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function readBasic(request) {
  const header = String(request.headers.get('authorization') || '');
  if (!header.startsWith('Basic ')) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(':');
    return separator < 0 ? null : [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return null;
  }
}

async function clientFromTokenRequest(request, form, config) {
  const credentials = readBasic(request);
  if (credentials) {
    const client = clientById(config, credentials[0]);
    if (!client || !timingSafeEqual(credentials[1], client.clientSecret)) return null;
    return client;
  }
  const clientId = String(form.get('client_id') || '');
  const client = await resolveClient(config, clientId);
  return client?.kind === 'CIMD' && client.tokenEndpointAuthMethod === 'none' ? client : null;
}

function validRefreshToken(payload, config, client, resource, current) {
  return Boolean(
    payload && payload.type === 'refresh' && payload.iss === config.issuer &&
    payload.aud === client.clientId && clientAllowsTokenIdentity(client, payload, config) &&
    payload.resource === resource && Number.isFinite(payload.exp) && payload.exp > current,
  );
}

export function createOAuthHandler(config = {}) {
  return async function handleOAuth(request) {
    const url = new URL(request.url);
    if (!configured(config)) return json({ code: 'OAUTH_NOT_CONFIGURED' }, 503);

    if (request.method === 'GET' && url.pathname === OBSERVATORY_CIMD_PATH) {
      return observatoryClientMetadata(config);
    }

    if (request.method === 'GET' && [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ].includes(url.pathname)) return metadata(
      config,
      url.pathname === '/.well-known/oauth-authorization-server/mcp'
        ? '/.well-known/oauth-authorization-server'
        : url.pathname,
    );

    try {
      if (url.pathname === '/oauth/authorize' && request.method === 'GET') {
        const values = await validateAuthorize(url.searchParams, config);
        return authorizePage({
          hidden: {
            response_type: 'code',
            client_id: values.client.clientId,
            redirect_uri: values.redirectUri,
            code_challenge: values.codeChallenge,
            code_challenge_method: 'S256',
            state: values.state,
            resource: values.resource,
            scope: values.requestedScope,
          },
          fixedIdentity: values.fixedIdentity,
          ownerId: config.ownerId || null,
        });
      }

      if (url.pathname === '/oauth/authorize' && request.method === 'POST') {
        const form = await request.formData();
        const values = new URLSearchParams();
        for (const key of ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state', 'resource', 'scope']) {
          values.set(key, String(form.get(key) || ''));
        }
        const checked = await validateAuthorize(values, config);
        const chosen = checked.fixedIdentity || actorIdentity(form.get('actor'));
        if (!chosen) return json({ code: 'ACTOR_REQUIRED' }, 400);
        if (checked.client.kind === 'REGISTERED' && chosen.subject !== checked.client.subject) return json({ code: 'ACTOR_MISMATCH' }, 400);
        const rateKey = 'owner-attempt:' + await sha256Hex(String(request.headers.get('cf-connecting-ip') || 'unknown') + ':' + checked.client.clientId + ':' + chosen.subject);
        if (await config.ledger.blocked(rateKey, nowSeconds(config))) return json({ code: 'OWNER_RATE_LIMITED' }, 429, { 'retry-after': '900' });
        const suppliedPasscode = String(form.get('passcode') || '');
        if (!timingSafeEqual(suppliedPasscode, config.ownerPasscode)) {
          await config.ledger.failure(rateKey, nowSeconds(config));
          return json({ code: 'OWNER_AUTH_FAILED' }, 403);
        }
        const code = await createTestAuthorizationCode({
          ...config,
          clientId: checked.client.clientId,
          subject: config.ownerId || chosen.subject,
          actor: config.ownerId ? chosen.subject : undefined,
          scope: chosen.scope,
          redirectUri: checked.redirectUri,
          codeChallenge: checked.codeChallenge,
          resource: checked.resource,
        });
        const redirect = new URL(checked.redirectUri);
        redirect.searchParams.set('code', code);
        if (checked.state) redirect.searchParams.set('state', checked.state);
        redirect.searchParams.set('iss', config.issuer);
        return Response.redirect(redirect.toString(), 302);
      }

      if (url.pathname === '/oauth/token' && request.method === 'POST') {
        const form = await request.formData();
        const client = await clientFromTokenRequest(request, form, config);
        if (!client) return json({ error: 'invalid_client' }, 401);

        let resource;
        try {
          resource = resolveClientResource(config, client, form.get('resource'));
        } catch {
          return json({ error: 'invalid_grant' }, 400);
        }
        const grantType = String(form.get('grant_type') || '');

        if (grantType === 'refresh_token') {
          const refreshToken = String(form.get('refresh_token') || '');
          if (!refreshToken) return json({ error: 'invalid_grant' }, 400);
          let refresh;
          try { refresh = await verifyEnvelope(refreshToken, config.signingKey); }
          catch { return json({ error: 'invalid_grant' }, 400); }
          const now = nowSeconds(config);
          if (!validRefreshToken(refresh, config, client, resource, now)) return json({ error: 'invalid_grant' }, 400);
          // An existing family identifier is retained across rotation. Legacy
          // refresh tokens without fid start a family from their signed jti.
          const familyId = String(refresh.fid || refresh.jti || '');
          if (!familyId || await config.ledger.refreshFamilyRevoked(familyId, now)) return json({ error: 'invalid_grant' }, 400);
          if (!await config.ledger.consume('refresh:' + await sha256Hex(refreshToken), refresh.exp)) {
            // Replay of a consumed refresh token invalidates all later tokens
            // in that family; fail closed instead of letting a thief rotate.
            await config.ledger.revokeRefreshFamily(familyId, now + refreshTokenTtlSeconds(config));
            return json({ error: 'invalid_grant' }, 400);
          }
          const rotatedRefreshToken = await createTestRefreshToken({ ...config, clientId: client.clientId, resource, subject: refresh.sub, actor: refresh.act, scope: refresh.scope, familyId });
          return json({
            access_token: await createTestAccessToken({ ...config, clientId: client.clientId, resource, subject: refresh.sub, actor: refresh.act, scope: refresh.scope }),
            token_type: 'Bearer',
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: rotatedRefreshToken,
            refresh_token_expires_in: refreshTokenTtlSeconds(config),
            scope: refresh.scope,
          }, 200, { 'cache-control': 'no-store' });
        }

        const redirectUri = String(form.get('redirect_uri') || '');
        if (grantType !== 'authorization_code' || !client.redirectUris.includes(redirectUri)) return json({ error: 'invalid_grant' }, 400);
        let code;
        try { code = await verifyEnvelope(String(form.get('code') || ''), config.signingKey); }
        catch { return json({ error: 'invalid_grant' }, 400); }
        const current = nowSeconds(config);
        if (code.type !== 'code' || code.iss !== config.issuer || code.aud !== client.clientId ||
            !clientAllowsTokenIdentity(client, code, config) || code.redirect_uri !== redirectUri || code.resource !== resource ||
            !Number.isFinite(code.exp) || code.exp <= current) {
          return json({ error: 'invalid_grant' }, 400);
        }
        const verifier = String(form.get('code_verifier') || '');
        if (!timingSafeEqual(await sha256Base64url(verifier), code.code_challenge)) return json({ error: 'invalid_grant' }, 400);
        if (!await config.ledger.consume('code:' + await sha256Hex(String(form.get('code'))), code.exp)) return json({ error: 'invalid_grant' }, 400);
        return json({
          access_token: await createTestAccessToken({ ...config, clientId: client.clientId, resource, subject: code.sub, actor: code.act, scope: code.scope }),
          token_type: 'Bearer',
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: await createTestRefreshToken({ ...config, clientId: client.clientId, resource, subject: code.sub, actor: code.act, scope: code.scope }),
          refresh_token_expires_in: refreshTokenTtlSeconds(config),
          scope: code.scope,
        }, 200, { 'cache-control': 'no-store' });
      }
    } catch (error) {
      const reason = String(error?.message || 'unknown');
      console.warn('OAUTH_BAD_REQUEST', { path: url.pathname, method: request.method, reason });
      const safeCodes = {
        'invalid client': 'OAUTH_INVALID_CLIENT',
        'invalid redirect uri': 'OAUTH_INVALID_REDIRECT_URI',
        'S256 PKCE is required': 'OAUTH_PKCE_REQUIRED',
        'invalid code challenge': 'OAUTH_INVALID_CODE_CHALLENGE',
        'invalid resource': 'OAUTH_INVALID_RESOURCE',
        'unsupported response type': 'OAUTH_UNSUPPORTED_RESPONSE_TYPE',
        'scope identity mismatch': 'OAUTH_SCOPE_IDENTITY_MISMATCH',
      };
      return json({ code: safeCodes[reason] || 'OAUTH_BAD_REQUEST' }, 400);
    }

    return json({ code: 'NOT_FOUND' }, 404);
  };
}
