// Preloaded (`node --import`) into the smoke's worker processes: records every
// outbound request to a Hyperliquid host (fetch, and the http/https requests
// that `ws` upgrades through) in WORKER_SMOKE_EGRESS_LOG, one line each, with
// the time. worker-smoke.mjs checks that a standby wrote nothing and that an
// active worker did. With WORKER_SMOKE_HL_STUB (an http origin on loopback)
// those requests are recorded, then answered by that stand-in instead of
// Hyperliquid: nothing leaves the host. (The api refuses an info URL other
// than Hyperliquid's own, so the stand-in is reached here, not by config.)
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.WORKER_SMOKE_EGRESS_LOG, stub = process.env.WORKER_SMOKE_HL_STUB ? new URL(process.env.WORKER_SMOKE_HL_STUB) : undefined;
const hyperliquid = /hyperliquid/i;
/** Records a Hyperliquid request; true when it goes to the stand-in instead. */
function record(target) {
  const text = String(target ?? '');
  if (!hyperliquid.test(text)) return false;
  if (log) appendFileSync(log, `${Date.now()} ${text}\n`);
  return stub !== undefined;
}
const stubbed = (target) => { const url = new URL(target); return new URL(`${url.pathname}${url.search}`, stub); };
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const target = input instanceof Request ? input.url : String(input);
  if (!record(target)) return fetch(input, init);
  return input instanceof Request ? fetch(new Request(stubbed(target), input), init) : fetch(stubbed(target), init);
};
const request = http.request;
for (const module of [http, https]) {
  const original = module.request, get = module.get;
  const target = (url, options) => typeof url === 'string' || url instanceof URL ? String(url) : `${url?.hostname ?? url?.host ?? options?.hostname ?? options?.host ?? ''}${url?.path ?? ''}`;
  // A stubbed request (a `ws` upgrade) goes to the stand-in over plain http, which refuses upgrades.
  const toStub = (url, options, callback) => {
    const path = typeof url === 'string' || url instanceof URL ? `${new URL(url).pathname}${new URL(url).search}` : url?.path ?? options?.path ?? '/';
    const done = typeof options === 'function' ? options : callback;
    return request({ host: stub.hostname, port: stub.port, path, method: url?.method ?? options?.method ?? 'GET', headers: url?.headers ?? options?.headers }, done);
  };
  module.request = (url, options, callback) => record(target(url, options)) ? toStub(url, options, callback) : original(url, options, callback);
  module.get = (url, options, callback) => {
    if (!record(target(url, options))) return get(url, options, callback);
    const req = toStub(url, options, callback); req.end(); return req;
  };
}
// ES module importers of node:http/https see the patched functions too.
syncBuiltinESMExports();
