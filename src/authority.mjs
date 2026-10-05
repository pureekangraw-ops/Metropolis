function value(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name}_REQUIRED`);
  return value.trim();
}

export function createAuthorityGate(grants = []) {
  const normalized = grants.map((grant) => Object.freeze({
    actor: value(grant.actor, 'grant.actor'),
    stationId: value(grant.stationId, 'grant.stationId'),
    operation: value(grant.operation, 'grant.operation'),
    workId: grant.workId == null ? '*' : value(grant.workId, 'grant.workId'),
  }));

  return async function authorize(request = {}) {
    const actor = value(request.actor, 'actor');
    const stationId = value(request.stationId, 'stationId');
    const operation = value(request.operation, 'operation');
    const workId = value(request.workId, 'workId');
    const allowed = normalized.some((grant) => (
      grant.actor === actor
      && grant.stationId === stationId
      && grant.operation === operation
      && (grant.workId === '*' || grant.workId === workId)
    ));
    return allowed
      ? { allowed: true, reason: 'GRANT_MATCH' }
      : { allowed: false, reason: 'NO_GRANT' };
  };
}
