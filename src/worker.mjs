import { createCityRuntime } from './city-runtime.mjs';
import { createCityService } from './city-entry.mjs';

let service;
let sourceSha;

function currentService(env = {}) {
  const nextSourceSha = env.SOURCE_SHA || env.CF_VERSION_METADATA?.id || 'UNKNOWN';
  if (!service || sourceSha !== nextSourceSha) {
    sourceSha = nextSourceSha;
    service = createCityService({ runtime: createCityRuntime({ sourceSha }) });
  }
  return service;
}

export default { fetch(request, env) { return currentService(env).fetch(request); } };
