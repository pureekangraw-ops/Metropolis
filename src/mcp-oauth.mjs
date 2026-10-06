// Derived from prytaneion-workspace/go-hub-oauth.mjs blob c59f770264a9117b97c78d5c7633aa90b3c45939.
// Independent Metropolis issuer; credentials and grants are never shared with the legacy Hub.
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ACCESS_TOKEN_TTL_SECONDS = 3600;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function base64url(bytes) {
  const value = typeof bytes === "string" ? encoder.encode(bytes) : bytes;
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function timingSafeEqual(left, right) {
  const a = typeof left === "string" ? encoder.encode(left) : left;
  const b = typeof right === "string" ? encoder.encode(right) : right;
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index % a.length] || 0) ^ (b[index % b.length] || 0);
  }
  return difference === 0;
}

async function signEnvelope(payload, signingKey) {
  const body = base64url(JSON.stringify(payload));
  return body + "." + base64url(await hmac(body, signingKey));
}

async function verifyEnvelope(value, signingKey) {
  const [body, signature, extra] = String(value || "").split(".");
  if (!body || !signature || extra) throw new Error("invalid signed envelope");
  const expected = await hmac(body, signingKey);
  if (!timingSafeEqual(fromBase64url(signature), expected)) throw new Error("invalid signed envelope");
  return JSON.parse(decoder.decode(fromBase64url(body)));
}

async function sha256Base64url(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function sha256Hex(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function allowedRedirectUris(config) {
  return [...new Set([
    config.redirectUri,
    ...(Array.isArray(config.redirectUris) ? config.redirectUris : []),
  ].map(value => String(value || "").trim()).filter(Boolean))];
}

function oauthClients(config) {
  const configuredClients = Array.isArray(config.clients) ? config.clients : [];
  const clients = configuredClients.length ? configuredClients : [{
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUris: allowedRedirectUris(config),
    subject: config.subject || "big",
    scope: config.scope || "go-hub",
  }];
  return clients.map(client => ({
    clientId: String(client?.clientId || "").trim(),
    clientSecret: String(client?.clientSecret || ""),
    redirectUris: [...new Set((Array.isArray(client?.redirectUris) ? client.redirectUris : [])
      .map(value => String(value || "").trim()).filter(Boolean))],
    resources: [...new Set((Array.isArray(client?.resources) ? client.resources : [])
      .map(value => String(value || "").trim()).filter(Boolean))],
    subject: String(client?.subject || "big"),
    scope: String(client?.scope || "go-hub"),
  })).filter(client => client.clientId && client.clientSecret && client.redirectUris.length);
}

function clientById(config, clientId) {
  return oauthClients(config).find(client => client.clientId === String(clientId || ""));
}

function configured(config) {
  return Boolean(
    config.issuer && config.signingKey && config.ownerPasscode && oauthClients(config).length &&
    config.ledger?.consume && config.ledger?.blocked && config.ledger?.failure,
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
  return String(config.resource || (config.issuer + "/mcp"));
}

function allowedClientResources(config, client) {
  const resources = Array.isArray(client?.resources) ? client.resources.filter(Boolean) : [];
  return resources.length ? resources : [defaultResource(config)];
}

function resolveClientResource(config, client, value) {
  const fallback = defaultResource(config);
  const resource = String(value || "").trim() || fallback;
  if (!allowedClientResources(config, client).includes(resource)) throw new Error("invalid resource");
  return resource;
}

function protectedResourceForMetadata(config, _path) {
  return defaultResource(config);
}

function validateAuthorize(input, config) {
  if (input.get("response_type") !== "code") throw new Error("unsupported response type");
  const client = clientById(config, input.get("client_id"));
  if (!client) throw new Error("invalid client");
  const redirectUri = String(input.get("redirect_uri") || "");
  if (!client.redirectUris.includes(redirectUri)) throw new Error("invalid redirect uri");
  if (input.get("code_challenge_method") !== "S256") throw new Error("S256 PKCE is required");
  const challenge = String(input.get("code_challenge") || "");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error("invalid code challenge");
  const resource = resolveClientResource(config, client, input.get("resource"));
  return {
    client,
    state: String(input.get("state") || ""),
    redirectUri,
    codeChallenge: challenge,
    resource,
  };
}

export async function createTestAuthorizationCode(config = {}) {
  const issuedAt = nowSeconds(config);
  return signEnvelope({
    type: "code",
    jti: crypto.randomUUID(),
    iss: config.issuer,
    aud: config.clientId,
    sub: config.subject || "big",
    redirect_uri: config.redirectUri,
    code_challenge: config.codeChallenge,
    resource: config.resource || config.issuer + "/mcp",
    scope: config.scope || "go-hub",
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
    type: "access",
    iss: config.issuer,
    aud: config.resource || config.issuer + "/mcp",
    ...(config.clientId ? { client_id: String(config.clientId) } : {}),
    sub: config.subject || "big",
    scope: config.scope || "go-hub",
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
    type: "refresh",
    jti: crypto.randomUUID(),
    iss: config.issuer,
    aud: config.clientId,
    sub: config.subject || "big",
    resource: config.resource || config.issuer + "/mcp",
    scope: config.scope || "go-hub",
    iat: issuedAt,
    exp: config.expiresAt ?? issuedAt + refreshTokenTtlSeconds(config),
  }, config.signingKey);
}

export async function verifyAccessToken(request, config = {}) {
  if (!config.issuer || !config.signingKey) throw new Error("OAuth is not configured");
  const authorization = String(request.headers.get("authorization") || "");
  if (!authorization.startsWith("Bearer ")) throw new Error("missing bearer token");
  const payload = await verifyEnvelope(authorization.slice(7), config.signingKey);
  const expectedResource = config.resource || config.issuer + "/mcp";
  const acceptedIdentities = Array.isArray(config.acceptedIdentities) && config.acceptedIdentities.length
    ? config.acceptedIdentities.map(identity =>
        String(identity?.subject || "") + "\u0000" + String(identity?.scope || ""))
    : Array.isArray(config.clients) && config.clients.length
      ? oauthClients(config).map(client => client.subject + "\u0000" + client.scope)
      : [(config.subject || "big") + "\u0000" + (config.scope || "go-hub")];
  const expectedClientId = String(config.clientId || "").trim();
  const acceptedClientIds = new Set([
    expectedClientId,
    ...(Array.isArray(config.acceptedClientIds) ? config.acceptedClientIds : []),
  ].map(value => String(value || "").trim()).filter(Boolean));
  if (payload.type !== "access" || payload.iss !== config.issuer || payload.aud !== expectedResource ||
      !acceptedIdentities.includes(String(payload.sub) + "\u0000" + String(payload.scope)) ||
      (config.requireClientId === true && (!acceptedClientIds.size ||
        (payload.client_id == null && config.allowLegacyClientId !== true) ||
        (payload.client_id != null && !acceptedClientIds.has(String(payload.client_id)))))) {
    throw new Error("invalid access token");
  }
  if (!Number.isFinite(payload.exp) || payload.exp <= nowSeconds(config)) throw new Error("expired access token");
  if (config.requireClientId === true && Array.isArray(config.clients)) {
    const client = oauthClients(config).find(client => client.clientId === payload.client_id);
    if (!client || client.subject !== payload.sub || client.scope !== payload.scope) throw new Error("client identity mismatch");
  }
  return { subject: payload.sub, scope: payload.scope };
}

function metadata(config, path) {
  if (path === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: config.issuer,
      authorization_endpoint: config.issuer + "/oauth/authorize",
      token_endpoint: config.issuer + "/oauth/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
      authorization_response_iss_parameter_supported: true,
    });
  }
  const resource = protectedResourceForMetadata(config, path);
  return json({
    resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...new Set(oauthClients(config).map(client => client.scope))],
    bearer_methods_supported: ["header"],
  });
}

function authorizePage(values) {
  const hidden = Object.entries(values).map(([name, value]) =>
    `<input type="hidden" name="${name}" value="${String(value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character])}">`
  ).join("");
  return new Response(`<!doctype html><html><meta name="viewport" content="width=device-width"><title>Metropolis authorization</title><body><main><h1>Metropolis</h1><p>Authorize this Metropolis connection.</p><form method="post">${hidden}<label>Owner passcode <input name="passcode" type="password" autocomplete="current-password" required></label><button type="submit">Authorize</button></form></main></body></html>`, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function readBasic(request) {
  const header = String(request.headers.get("authorization") || "");
  if (!header.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    return separator < 0 ? null : [decoded.slice(0, separator), decoded.slice(separator + 1)];
  } catch {
    return null;
  }
}

function validRefreshToken(payload, config, client, resource, current) {
  return Boolean(
    payload && payload.type === "refresh" && payload.iss === config.issuer &&
    payload.aud === client.clientId && payload.sub === client.subject && payload.scope === client.scope &&
    payload.resource === resource && Number.isFinite(payload.exp) && payload.exp > current,
  );
}

export function createOAuthHandler(config = {}) {
  return async function handleOAuth(request) {
    const url = new URL(request.url);
    if (!configured(config)) return json({ code: "OAUTH_NOT_CONFIGURED" }, 503);

    if (request.method === "GET" && [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ].includes(url.pathname)) return metadata(config, url.pathname);

    try {
      if (url.pathname === "/oauth/authorize" && request.method === "GET") {
        const values = validateAuthorize(url.searchParams, config);
        return authorizePage({
          response_type: "code",
          client_id: values.client.clientId,
          redirect_uri: values.redirectUri,
          code_challenge: values.codeChallenge,
          code_challenge_method: "S256",
          state: values.state,
          resource: values.resource,
        });
      }

      if (url.pathname === "/oauth/authorize" && request.method === "POST") {
        const form = await request.formData();
        const values = new URLSearchParams();
        for (const key of ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "resource"]) {
          values.set(key, String(form.get(key) || ""));
        }
        const checked = validateAuthorize(values, config);
        const rateKey = "owner-attempt:" + await sha256Hex(String(request.headers.get("cf-connecting-ip") || "unknown") + ":" + checked.client.clientId);
        if (await config.ledger.blocked(rateKey, nowSeconds(config))) return json({ code: "OWNER_RATE_LIMITED" }, 429, { "retry-after": "900" });
        const suppliedPasscode = String(form.get("passcode") || "");
        if (!timingSafeEqual(suppliedPasscode, config.ownerPasscode)) {
          await config.ledger.failure(rateKey, nowSeconds(config));
          return json({ code: "OWNER_AUTH_FAILED" }, 403);
        }
        const code = await createTestAuthorizationCode({
          ...config,
          clientId: checked.client.clientId,
          subject: checked.client.subject,
          scope: checked.client.scope,
          redirectUri: checked.redirectUri,
          codeChallenge: checked.codeChallenge,
          resource: checked.resource,
        });
        const redirect = new URL(checked.redirectUri);
        redirect.searchParams.set("code", code);
        if (checked.state) redirect.searchParams.set("state", checked.state);
        redirect.searchParams.set("iss", config.issuer);
        return Response.redirect(redirect.toString(), 302);
      }

      if (url.pathname === "/oauth/token" && request.method === "POST") {
        const credentials = readBasic(request);
        const client = credentials ? clientById(config, credentials[0]) : null;
        if (!client || !timingSafeEqual(credentials[1], client.clientSecret)) {
          return json({ error: "invalid_client" }, 401);
        }

        const form = await request.formData();
        let resource;
        try {
          resource = resolveClientResource(config, client, form.get("resource"));
        } catch {
          return json({ error: "invalid_grant" }, 400);
        }
        const grantType = String(form.get("grant_type") || "");

        if (grantType === "refresh_token") {
          const refreshToken = String(form.get("refresh_token") || "");
          if (!refreshToken) return json({ error: "invalid_grant" }, 400);
          let refresh;
          try {
            refresh = await verifyEnvelope(refreshToken, config.signingKey);
          } catch {
            return json({ error: "invalid_grant" }, 400);
          }
          if (!validRefreshToken(refresh, config, client, resource, nowSeconds(config))) {
            return json({ error: "invalid_grant" }, 400);
          }
          if (!await config.ledger.consume("refresh:" + await sha256Hex(refreshToken), refresh.exp)) return json({ error: "invalid_grant" }, 400);
          const rotatedRefreshToken = await createTestRefreshToken({
            ...config,
            clientId:client.clientId,
            resource,
            subject:client.subject,
            scope:client.scope,
          });
          return json({
            access_token: await createTestAccessToken({ ...config, clientId: client.clientId, resource, subject: client.subject, scope: client.scope }),
            token_type: "Bearer",
            expires_in: ACCESS_TOKEN_TTL_SECONDS,
            refresh_token: rotatedRefreshToken,
            refresh_token_expires_in: refreshTokenTtlSeconds(config),
            scope: client.scope,
          }, 200, { "cache-control": "no-store" });
        }

        const redirectUri = String(form.get("redirect_uri") || "");
        if (grantType !== "authorization_code" || !client.redirectUris.includes(redirectUri)) {
          return json({ error: "invalid_grant" }, 400);
        }
        const code = await verifyEnvelope(String(form.get("code") || ""), config.signingKey);
        const current = nowSeconds(config);
        if (code.type !== "code" || code.iss !== config.issuer || code.aud !== client.clientId ||
            code.sub !== client.subject || code.scope !== client.scope || code.redirect_uri !== redirectUri || code.resource !== resource ||
            !Number.isFinite(code.exp) || code.exp <= current) {
          return json({ error: "invalid_grant" }, 400);
        }
        const verifier = String(form.get("code_verifier") || "");
        if (!timingSafeEqual(await sha256Base64url(verifier), code.code_challenge)) {
          return json({ error: "invalid_grant" }, 400);
        }
        if (!await config.ledger.consume("code:" + await sha256Hex(String(form.get("code"))), code.exp)) return json({ error: "invalid_grant" }, 400);
        return json({
          access_token: await createTestAccessToken({ ...config, clientId: client.clientId, resource, subject: client.subject, scope: client.scope }),
          token_type: "Bearer",
          expires_in: ACCESS_TOKEN_TTL_SECONDS,
          refresh_token: await createTestRefreshToken({ ...config, clientId: client.clientId, resource, subject: client.subject, scope: client.scope }),
          refresh_token_expires_in: refreshTokenTtlSeconds(config),
          scope: client.scope,
        }, 200, { "cache-control": "no-store" });
      }
    } catch {
      return json({ code: "OAUTH_BAD_REQUEST" }, 400);
    }

    return json({ code: "NOT_FOUND" }, 404);
  };
}
