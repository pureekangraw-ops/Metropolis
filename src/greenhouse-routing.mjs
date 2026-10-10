/**
 * Greenhouse-first coordination policy.
 * Pure policy boundary: does not register a station, dispatch, or change live routes.
 */
export const GREENHOUSE_STATION = 'GREENHOUSE_STATION';
export const FACTORY_STATION = 'FACTORY_STATION';

export class RoutingDenied extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'RoutingDenied';
    this.code = 'ROUTING_DENIED';
  }
}

/**
 * Resolve a new work handoff. Factory is an executor behind Greenhouse,
 * never a direct Metropolis coordination destination.
 *
 * Existing journeys must be reconciled separately before production cutover.
 */
export function resolveCoordinationRoute({
  actor, workId, checkpointId, operation, targetStation,
  authorization, greenhouse,
}) {
  if (!actor || !workId || !checkpointId || !operation) {
    throw new RoutingDenied('MISSING_WORK_CONTEXT');
  }
  if (!authorization?.verified || authorization.actor !== actor ||
      authorization.workId !== workId ||
      authorization.checkpointId !== checkpointId ||
      !authorization.operations?.includes(operation)) {
    throw new RoutingDenied('AUTHORIZATION_NOT_VERIFIED');
  }
  if (!targetStation) throw new RoutingDenied('MISSING_TARGET');
  if (targetStation === GREENHOUSE_STATION) {
    throw new RoutingDenied('RECURSIVE_GREENHOUSE_DESTINATION');
  }
  if (!greenhouse?.registered || !greenhouse?.authenticated ||
      !greenhouse?.healthy || !greenhouse?.supportsHandoff) {
    throw new RoutingDenied('GREENHOUSE_NOT_READY');
  }
  return Object.freeze({
    stationId: GREENHOUSE_STATION,
    operation: 'coordinate',
    payload: Object.freeze({
      actor, workId, checkpointId, operation, targetStation,
    }),
  });
}
