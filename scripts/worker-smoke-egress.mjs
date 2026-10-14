// Preloaded (`node --import`) into the smoke's worker processes: records every
// outbound request to a Hyperliquid host (fetch, and the http/https requests
// that `ws` upgrades through) in WORKER_SMOKE_EGRESS_LOG, one line each, with
// the time. worker-smoke.mjs checks that a standby wrote nothing.
import { appendFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const log = process.env.WORKER_SMOKE_EGRESS_LOG;
const hyperliquid = /hyperliquid/i;
function record(target) {
  const text = String(target ?? '');
  if (log && hyperliquid.test(text)) appendFileSync(log, `${Date.now()} ${text}\n`);
}
const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => { record(input instanceof Request ? input.url : input); return fetch(input, init); };
for (const module of [http, https]) {
  const request = module.request, get = module.get;
  const target = (url, options) => typeof url === 'string' || url instanceof URL ? String(url) : `${url?.hostname ?? url?.host ?? options?.hostname ?? options?.host ?? ''}${url?.path ?? ''}`;
  module.request = (url, options, callback) => { record(target(url, options)); return request(url, options, callback); };
  module.get = (url, options, callback) => { record(target(url, options)); return get(url, options, callback); };
}
// ES module importers of node:http/https see the patched functions too.
syncBuiltinESMExports();
