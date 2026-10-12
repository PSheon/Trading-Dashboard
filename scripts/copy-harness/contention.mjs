#!/usr/bin/env node
// Copy harness — Stage-like pressure on the Hyperliquid meter (TEST ONLY).
//
// On Stage the worker's analytics, cohort, discovery and snapshot loops keep
// the shared meter's background lane full and keep retrying, on the same
// egress key as the copy's orders (2026-10-12: an order's meter transactions
// queued behind them). The local stack has no such load. This keeps the
// background lane of the orders' egress key full the same way
// (apps/api/test/manual-live-evidence-latency.e2e-spec.ts `contention`):
// eight loops asking for 20 weight each (backing off on a refusal), and two
// socket leases that come and go. It spends only meter rows, never a request
// to Hyperliquid. run.mjs --contention runs it beside the scenarios.
//
//   node scripts/copy-harness/contention.mjs [--egress <key>] [--loops 8] [--sockets 2] [--seconds 0 (until killed)]
//
// The egress key defaults to the testnet copies' (`<HYPERLIQUID_EGRESS_KEY>:testnet`,
// apps/api wallet-network-hyperliquid.ts); the database to the repo .env's
// DATABASE_URL (HARNESS_DATABASE_URL wins). COPY_HARNESS_DB_RTT_MS applies the
// stack's round trip to these transactions too (db-rtt.mjs). Needs a built
// api (apps/api/dist). Prints one JSON line of counts every 10 s; never a secret.
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as wait } from "node:timers/promises";
import { installDbRtt, rttFromEnv } from "./db-rtt.mjs";
import { loadEnv } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const log = (event, data = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
const env = { ...(() => { try { return loadEnv(); } catch { return {}; } })(), ...process.env };
const databaseUrl = process.env.HARNESS_DATABASE_URL || env.DATABASE_URL;
const egressKey = flag("egress", env.HYPERLIQUID_EGRESS_KEY ? `${env.HYPERLIQUID_EGRESS_KEY}:testnet` : null);
const loops = Number(flag("loops", "8")), socketLoops = Number(flag("sockets", "2")), seconds = Number(flag("seconds", "0"));
if (!databaseUrl || !egressKey || !/^[A-Za-z0-9:._-]{1,128}$/.test(egressKey) || !(loops >= 0) || !(socketLoops >= 0)) {
  console.error("contention.mjs needs DATABASE_URL and an egress key (HYPERLIQUID_EGRESS_KEY in .env, or --egress)");
  process.exit(2);
}

const api = resolve(import.meta.dirname, "../../apps/api");
const apiRequire = createRequire(resolve(api, "package.json"));
const fromApi = (name) => import(pathToFileURL(apiRequire.resolve(name)).href);
const fromDist = (path) => import(pathToFileURL(resolve(api, "dist", path)).href);
const pg = apiRequire("pg");
const rtt = rttFromEnv(env);
installDbRtt(pg.Client, rtt);
const [{ drizzle }, schema, { UnitOfWork }, { PostgresHyperliquidQuota }, { sharedRestRetryAfterMs }] = await Promise.all([
  fromApi("drizzle-orm/node-postgres"), fromApi("@trading-dashboard/shared/database"), fromDist("db/unit-of-work.js"),
  fromDist("hyperliquid/postgres-hyperliquid-quota.js"), fromDist("hyperliquid/hyperliquid-capacity-error.js")]);

const pool = new pg.Pool({ connectionString: databaseUrl, max: loops + socketLoops + 2 });
const quota = new PostgresHyperliquidQuota(new UnitOfWork(drizzle(pool, { schema })));
const stop = new AbortController();
const counts = { granted: 0, refused: 0, sockets: 0, socketRefused: 0, errors: 0 };
const background = async (n) => {
  const bound = quota.bindUnscoped({ egressKey, ownerId: `harness-background-${n}` });
  while (!stop.signal.aborted) {
    try { await bound.acquireRest(20, Date.now() + 5000, "background"); counts.granted++; await wait(50); }
    catch (error) {
      const retry = sharedRestRetryAfterMs(error);
      if (retry === undefined) counts.errors++; else counts.refused++;
      await wait(Math.min(retry ?? 1000, 250 + Math.random() * 250));
    }
  }
};
const sockets = async (n) => {
  const bound = quota.bindUnscoped({ egressKey, ownerId: `harness-socket-${n}` });
  while (!stop.signal.aborted) {
    try { const r = await bound.reserveSocket(Date.now() + 5000, "testnet"); counts.sockets++; await r.connection.cancelBeforeConnect(); }
    catch { counts.socketRefused++; }
    await wait(4000);
  }
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => stop.abort());
if (seconds > 0) setTimeout(() => stop.abort(), seconds * 1000).unref();
const ticker = setInterval(() => log("contention", { rttMs: rtt, ...counts }), 10_000);
log("contention_start", { egress: flag("egress") ? "--egress" : "HYPERLIQUID_EGRESS_KEY:testnet", rttMs: rtt, loops, sockets: socketLoops });
await Promise.all([...Array.from({ length: loops }, (_, n) => background(n)), ...Array.from({ length: socketLoops }, (_, n) => sockets(n))]);
clearInterval(ticker);
await pool.end();
log("contention_done", { rttMs: rtt, ...counts });
