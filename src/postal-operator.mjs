import { acknowledgeCargo, deliverCargo, retryCargo, returnCargo, routeCargo } from './post-office.mjs';

export function createPostalOperator({ postOffice = { routeCargo, deliverCargo, acknowledgeCargo, retryCargo, returnCargo }, actorId = 'PIXIE' } = {}) {
  return Object.freeze({
    actorId,
    route(envelope, input) { return postOffice.routeCargo(envelope, input); },
    deliver(envelope, input) { return postOffice.deliverCargo(envelope, input); },
    acknowledge(envelope, input) { return postOffice.acknowledgeCargo(envelope, input); },
    retry(envelope, input) { return postOffice.retryCargo(envelope, input); },
    return(envelope, input) { return postOffice.returnCargo(envelope, input); },
  });
}
