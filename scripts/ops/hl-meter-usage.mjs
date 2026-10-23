#!/usr/bin/env node
// READ ONLY. Samples the Hyperliquid meter rows (hyperliquid_egress_quota) per
// egress key — the copy side's shared meter and the read worker's own
// (`<key>:read`, decision D12) — and, when the workers' health URLs are given,
// each worker's 429 counts from its heartbeat. One JSON line per sample.
//
//   DATABASE_URL=… node scripts/ops/hl-meter-usage.mjs [--samples N] [--interval SECONDS]
//   WORKER_URL=http://worker.railway.internal:3000 WORKER_READ_URL=http://worker-read.railway.internal:3000 (optional)
//
// Defaults: one sample; 60 s between samples. A 24 h comparison of the two
// IPs' 429 rates: `--samples 1440 --interval 60 > meter-24h.jsonl`, from a
// shell that reaches the database and the workers' private network (a Railway
// shell, or an SSH tunnel). Every read is one READ ONLY transaction that is
// rolled back; nothing is written, and the connection string is never printed.
// The egress keys are printed with the shared key replaced by `<key>`.
//
// Per meter: `lanes` (units alive in the window by class, and how many
// charges), `total`, the `backgroundCap` the meter's process applies by default
// (READ_WORKER_BACKGROUND_REST_CAP 900 on a read key, HYPERLIQUID_BACKGROUND_REST_CAP
// 840 elsewhere unless that service sets the variable) and `reserved`
// (1,200 − cap). The 429 counts are per process (foreignUsage.rateLimited:
// every 429 or WS rate limit since the process started; `count`: those while
// our own meter held under 80 % of the window, i.e. someone else's traffic on
// that IP), read from each worker's GET /health; the rows hold charges only.
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";

const require = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { Client } = require("pg");

const REST_CAP = 1200, READ_BACKGROUND_CAP = 900, SHARED_BACKGROUND_CAP = 840;
const SQL = `
with now_ms as (select (extract(epoch from clock_timestamp())*1000)::bigint as ms),
ev as (select q.egress_key, e from hyperliquid_egress_quota q, jsonb_array_elements(q.events) e),
rest as (select egress_key, e->>'id' as id, (e->>'units')::int as units from ev, now_ms where e->>'kind'='rest' and (e->>'expiresAt')::bigint > now_ms.ms),
lanes as (select egress_key,
  case when id like 'bg:%' then 'background' when id like 'page:%' then 'page' when id like 'source:%' then 'source'
       when id like 'live:%' then 'live' when id like 'setup:%' then 'setup' when id like 'setup-hold:%' then 'setup_hold'
       when id like 'live-demand:%' or id like 'live-standby:%' or id like 'source-standby:%' or id like 'setup-demand:%' then 'markers'
       else 'other' end as lane,
  sum(units)::int as units, count(*)::int as n from rest group by 1, 2)
select k.egress_key, coalesce(json_object_agg(l.lane, json_build_object('units', l.units, 'n', l.n)) filter (where l.lane is not null), '{}'::json) as lanes
from hyperliquid_egress_quota k left join lanes l on l.egress_key = k.egress_key group by k.egress_key order by k.egress_key`;

function args(argv) {
  const out = { samples: 1, interval: 60 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = argv[i].includes("=") ? argv[i].split("=", 2) : [argv[i], argv[++i]];
    if (flag === "--samples") out.samples = Number(value);
    else if (flag === "--interval") out.interval = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!Number.isInteger(out.samples) || out.samples < 1 || !Number.isFinite(out.interval) || out.interval < 1) throw new Error("--samples must be a positive integer and --interval at least 1 second");
  return out;
}

/** `<key>` for the shortest key, `<key>:read`, `<key>:testnet`, … for the rest. */
function labels(keys) {
  const shared = [...keys].sort((a, b) => a.length - b.length)[0];
  return Object.fromEntries(keys.map((key) => [key, key === shared ? "<key>" : key.startsWith(`${shared}:`) ? `<key>${key.slice(shared.length)}` : "<other>"]));
}
const isRead = (key) => /(^|:)read(:|$)/.test(key);

async function meters(client) {
  await client.query("BEGIN READ ONLY");
  try {
    const { rows } = await client.query(SQL);
    const label = labels(rows.map((r) => r.egress_key));
    const out = {};
    for (const row of rows) {
      const lanes = row.lanes, total = Object.values(lanes).reduce((sum, l) => sum + l.units, 0);
      const backgroundCap = isRead(row.egress_key) ? READ_BACKGROUND_CAP : SHARED_BACKGROUND_CAP;
      out[label[row.egress_key]] = { meter: isRead(row.egress_key) ? "read" : "copy", total, lanes, backgroundCap, reserved: REST_CAP - backgroundCap };
    }
    return out;
  } finally { await client.query("ROLLBACK"); }
}

async function rateLimited(role, url) {
  if (!url) return undefined;
  try {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(3000), cache: "no-store" });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const beat = await response.json();
    const usage = beat?.foreignUsage;
    return { role: beat?.worker?.role ?? role, meter: beat?.meter?.meter ?? null, rateLimited: usage?.rateLimited ?? null, foreignSuspected: usage?.count ?? null, lastAt: usage?.lastAt ?? null,
      publicIps: beat?.egressIdentity?.publicIps ?? null };
  } catch (error) { return { error: error instanceof Error ? error.message : "failed" }; }
}

async function main() {
  const { samples, interval } = args(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required (never printed)");
  const client = new Client({ connectionString: url, statement_timeout: 5000, application_name: "hl-meter-usage" });
  await client.connect();
  try {
    for (let i = 0; i < samples; i++) {
      const [rows, copy, read] = await Promise.all([meters(client), rateLimited("copy", process.env.WORKER_URL), rateLimited("read", process.env.WORKER_READ_URL)]);
      const line = { at: new Date().toISOString(), meters: rows, ...(copy || read ? { workers: { ...(copy ? { copy } : {}), ...(read ? { read } : {}) } } : {}) };
      process.stdout.write(`${JSON.stringify(line)}\n`);
      if (i + 1 < samples) await sleep(interval * 1000);
    }
  } finally { await client.end(); }
}

main().catch((error) => {
  // Never the connection string: pg's errors can quote it.
  process.stderr.write(`hl-meter-usage: ${String(error instanceof Error ? error.message : error).replace(/postgres(ql)?:\/\/\S+/g, "<db>")}\n`);
  process.exit(1);
});
