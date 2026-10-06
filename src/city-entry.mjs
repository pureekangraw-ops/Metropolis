import { createCityRuntime } from './city-runtime.mjs';

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } }); }

export function createCityService({ runtime = createCityRuntime() } = {}) {
  return Object.freeze({
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/health') return json(await runtime.health());
      if (request.method === 'POST' && url.pathname === '/work/intake') {
        try { return json(await runtime.intake(await request.json()), 201); } catch (error) { return json({ status: 'UNKNOWN', reason: error.code || error.message }, 409); }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/work/')) {
        const record = await runtime.getWork(decodeURIComponent(url.pathname.slice('/work/'.length)));
        return record ? json(record) : json({ status: 'UNKNOWN', reason: 'WORK_NOT_FOUND' }, 404);
      }
      return json({ status: 'UNKNOWN', reason: 'ROUTE_NOT_FOUND' }, 404);
    },
  });
}
