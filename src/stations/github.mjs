const API_VERSION = '2022-11-28';

export class GitHubRailError extends Error {
  constructor(stage, code, message) {
    super(message);
    this.stage = stage;
    this.code = code;
  }
}

function apiUrl(owner, repo, suffix = '') {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

async function jsonRequest(fetchImpl, url, { token, method = 'GET', body } = {}) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': API_VERSION };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await response.json(); } catch { /* keep response metadata only */ }
  return { response, json };
}

function statusFromResponse(response) {
  if (response.ok) return 'READY';
  if (response.status === 401) return 'DENIED';
  if (response.status === 403) return 'DEGRADED';
  if (response.status === 404) return 'UNAVAILABLE';
  return 'UNKNOWN';
}

function writeCapabilityFor(repository, token) {
  if (!token) return { status: 'UNKNOWN', reason: 'WRITE_CREDENTIAL_UNAVAILABLE' };
  if (typeof repository?.permissions?.push !== 'boolean') return { status: 'UNKNOWN', reason: 'WRITE_PERMISSION_UNVERIFIED' };
  return repository.permissions.push
    ? { status: 'READY', reason: 'WRITE_PERMISSION_CONFIRMED' }
    : { status: 'DENIED', reason: 'WRITE_PERMISSION_DENIED' };
}

export function createGitHubRailAdapter({ owner, repo, token = '', fetchImpl = fetch, now = () => new Date().toISOString() }) {
  if (!owner || !repo) throw new TypeError('github_owner_repo_REQUIRED');

  async function probe({ station, rail }) {
    const result = await jsonRequest(fetchImpl, apiUrl(owner, repo), { token });
    const status = statusFromResponse(result.response);
    const readCapability = { status: result.response.ok ? 'READY' : status, reason: result.response.ok ? 'REPOSITORY_READ_CONFIRMED' : 'REPOSITORY_READ_UNAVAILABLE' };
    const writeCapability = writeCapabilityFor(result.json, token);
    return {
      status,
      identity: { stationId: station.stationId, railId: rail.railId, ownerSystem: station.ownerSystem },
      scope: ['READ_REPOSITORY', ...(writeCapability.status === 'READY' ? ['CREATE_BRANCH'] : [])],
      capabilities: { READ_REPOSITORY: readCapability, CREATE_BRANCH: writeCapability },
      connectivity: { status, httpStatus: result.response.status },
      limit: { status: 'UNKNOWN' },
      readback: { supported: result.response.ok },
      observedAt: now(),
    };
  }

  async function dispatch({ oath }) {
    if (oath.operation === 'READ_REPOSITORY') {
      const result = await jsonRequest(fetchImpl, apiUrl(owner, repo), { token });
      if (!result.response.ok) throw new GitHubRailError('DESTINATION', `GITHUB_HTTP_${result.response.status}`, 'GitHub repository read failed');
      return { accepted: true, receiptId: `github:read:${owner}/${repo}:${now()}`, providerRef: apiUrl(owner, repo), response: result.json, acceptedAt: now() };
    }
    if (oath.operation === 'CREATE_BRANCH') {
      if (!token) throw new GitHubRailError('AUTH', 'GITHUB_TOKEN_REQUIRED', 'A credential is required for branch creation');
      const branch = String(oath.payload?.branch || '').trim();
      const fromSha = String(oath.payload?.fromSha || '').trim();
      if (!branch || !fromSha) throw new GitHubRailError('DESTINATION', 'BRANCH_INPUT_REQUIRED', 'branch and fromSha are required');
      const result = await jsonRequest(fetchImpl, `${apiUrl(owner, repo)}/git/refs`, { token, method: 'POST', body: { ref: `refs/heads/${branch}`, sha: fromSha } });
      if (result.response.status !== 201) throw new GitHubRailError('DESTINATION', `GITHUB_HTTP_${result.response.status}`, 'GitHub branch creation failed');
      return { accepted: true, receiptId: `github:branch:${owner}/${repo}:${branch}:${now()}`, providerRef: `${apiUrl(owner, repo)}/git/ref/heads/${branch}`, branch, fromSha, acceptedAt: now() };
    }
    throw new GitHubRailError('DESTINATION', 'OPERATION_UNSUPPORTED', `Unsupported GitHub operation: ${oath.operation}`);
  }

  async function readback({ oath, receipt }) {
    if (oath.operation === 'READ_REPOSITORY') {
      const result = await jsonRequest(fetchImpl, apiUrl(owner, repo), { token });
      const verified = result.response.ok && result.json?.id === receipt.response?.id;
      return { verified, evidenceRef: verified ? receipt.providerRef : null, observedAt: now(), owner, repo };
    }
    if (oath.operation === 'CREATE_BRANCH') {
      const branch = receipt.branch;
      const result = await jsonRequest(fetchImpl, `${apiUrl(owner, repo)}/git/ref/heads/${encodeURIComponent(branch)}`, { token });
      const verified = result.response.ok && result.json?.object?.sha === receipt.fromSha;
      return { verified, evidenceRef: verified ? `${apiUrl(owner, repo)}/tree/${encodeURIComponent(branch)}` : null, observedAt: now(), branch, observedSha: result.json?.object?.sha || null };
    }
    throw new GitHubRailError('READBACK', 'OPERATION_UNSUPPORTED', `Unsupported GitHub operation: ${oath.operation}`);
  }

  return Object.freeze({ probe, dispatch, readback });
}
