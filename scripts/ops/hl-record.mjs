#!/usr/bin/env node
// READ ONLY. Records what Hyperliquid's public `POST /info` endpoint answers
// for the reads the live copy path makes about a leader and a follower, as the
// bytes received, under apps/api/test/fixtures/hyperliquid/<network>/<date>/.
// No auth, no database, no exchange call; the public rate limit is respected
// (one request at a time, a pause between them). Never run in CI: the
// fixtures are committed and the specs replay them (test/support/).
//
//   node scripts/ops/hl-record.mjs --network mainnet --address 0x… [--address 0x…]
//        [--exclude <file>] [--hours 24] [--max-fills 500] [--out <dir>] [--date YYYY-MM-DD]
//
// Addresses are public on-chain data, but nothing is recorded about our own
// follower accounts: an address listed in the `--exclude` file (one per line,
// `#` comments) refuses the whole run before any request leaves.
//
// Per network: perpDexs, spotMeta, allPerpMetas, meta, metaAndAssetCtxs.
// Per address: userRole, userAbstraction, userDexAbstraction,
// spotClearinghouseState, clearinghouseState (the main dex and every listed
// dex: the REST form of the observer's allDexsClearinghouseState aggregate),
// frontendOpenOrders, userFees, userFillsByTime, userTwapSliceFillsByTime and
// userFunding over the last `--hours`, activeAssetData for the coin of the
// newest fill (or first position) and orderStatus for that fill's oid and for
// oid 1 (an order the account never placed: the "unknownOid" answer).
// A fills or TWAP list longer than `--max-fills` keeps its newest rows only,
// re-serialised, and index.json says so; every other file is the exact bytes.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const ENDPOINTS = { mainnet: "https://api.hyperliquid.xyz/info", testnet: "https://api.hyperliquid-testnet.xyz/info" };
export const DEFAULT_OUT = fileURLToPath(new URL("../../apps/api/test/fixtures/hyperliquid", import.meta.url));
/** Lists the copy path reads with a time window; only these are ever truncated or filtered. */
export const WINDOWED_TYPES = ["userFillsByTime", "userTwapSliceFillsByTime", "userFunding"];
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Hyperliquid's documented list cap, above which the recorder refuses to believe a shape. */
const RESPONSE_BYTES_CAP = 16 * 1024 * 1024;
const SIZE_BUDGET = 2 * 1024 * 1024;

export function parseArgs(argv) {
  const out = { addresses: [], network: undefined, exclude: undefined, hours: 24, maxFills: 500, out: DEFAULT_OUT, date: new Date().toISOString().slice(0, 10), sleepMs: 250 };
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = argv[i].includes("=") ? argv[i].split("=", 2) : [argv[i], argv[++i]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--address") out.addresses.push(...value.split(",").map((a) => a.trim()).filter(Boolean));
    else if (flag === "--network") out.network = value;
    else if (flag === "--exclude") out.exclude = value;
    else if (flag === "--hours") out.hours = Number(value);
    else if (flag === "--max-fills") out.maxFills = Number(value);
    else if (flag === "--out") out.out = value;
    else if (flag === "--date") out.date = value;
    else if (flag === "--sleep-ms") out.sleepMs = Number(value);
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!ENDPOINTS[out.network]) throw new Error("--network must be mainnet or testnet");
  if (out.addresses.length === 0) throw new Error("at least one --address is required");
  for (const a of out.addresses) if (!ADDRESS.test(a)) throw new Error(`not an address: ${a}`);
  if (!Number.isFinite(out.hours) || out.hours <= 0 || out.hours > 24 * 90) throw new Error("--hours must be between 0 and 2160");
  if (!Number.isInteger(out.maxFills) || out.maxFills < 1) throw new Error("--max-fills must be a positive integer");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error("--date must be YYYY-MM-DD");
  if (!Number.isInteger(out.sleepMs) || out.sleepMs < 0) throw new Error("--sleep-ms must be a non-negative integer");
  out.addresses = [...new Set(out.addresses.map((a) => a.toLowerCase()))];
  return out;
}

/** The addresses an exclude file lists (one per line, `#` comments), lower-cased. */
export function parseExclusions(text) {
  return new Set(text.split(/\r?\n/).map((line) => line.replace(/#.*/, "").trim()).filter(Boolean).map((a) => a.toLowerCase()));
}
/** The requested addresses the exclude list refuses (our own accounts are never recorded). */
export function excluded(addresses, exclusions) {
  return addresses.filter((a) => exclusions.has(a.toLowerCase()));
}

const prefix = (address) => address.slice(2, 10);
/** `<type>[-<address prefix>][-<qualifier>].json`; a dex, coin or oid qualifies the file, with only [A-Za-z0-9_.-] kept. */
export function fixtureName(body) {
  const parts = [body.type];
  if (body.user) parts.push(prefix(body.user));
  for (const key of ["dex", "coin", "oid"]) if (body[key] !== undefined && body[key] !== "") parts.push(String(body[key]).replace(/[^A-Za-z0-9_.-]/g, "_"));
  return `${parts.join("-")}.json`;
}

/** The newest `max` rows of a list ordered oldest first (what the ByTime endpoints return). */
export function truncateRows(rows, max) {
  if (!Array.isArray(rows) || rows.length <= max) return { rows, truncated: null };
  const kept = rows.slice(rows.length - max);
  return { rows: kept, truncated: { originalRows: rows.length, keptRows: kept.length } };
}

const timeOf = (row) => (row && typeof row === "object" && Number.isSafeInteger(row.time) ? row.time : Number.isSafeInteger(row?.fill?.time) ? row.fill.time : null);

/**
 * Records one network's shared reads and every address's reads under
 * `<out>/<network>/<date>/`. `io.fetch`, `io.sleep`, `io.write`, `io.now`
 * are the only effects (tests pass their own).
 */
export async function record(options, io) {
  const { network, addresses, hours, maxFills, date, sleepMs } = options;
  const endpoint = ENDPOINTS[network], dir = join(options.out, network, date);
  const now = io.now(), startTime = now - Math.round(hours * 3600_000);
  const entries = []; let bytes = 0;
  const post = async (body) => {
    if (entries.length) await io.sleep(sleepMs);
    const response = await io.fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(20_000) });
    const text = await response.text();
    if (!response.ok) throw new Error(`${body.type} answered HTTP ${response.status}`);
    if (text.length > RESPONSE_BYTES_CAP) throw new Error(`${body.type} answer exceeds ${RESPONSE_BYTES_CAP} bytes`);
    return { text, parsed: JSON.parse(text) };
  };
  const save = async (body) => {
    const { text, parsed } = await post(body);
    let fileText = text, truncated = null, coverage;
    if (WINDOWED_TYPES.includes(body.type)) {
      const cut = truncateRows(parsed, maxFills);
      truncated = cut.truncated;
      if (truncated) fileText = JSON.stringify(cut.rows);
      const times = cut.rows.map(timeOf).filter((t) => t !== null);
      // What the file can answer for: the request window, narrowed to the kept rows' times after a cut.
      coverage = { from: truncated ? Math.min(...times) : body.startTime, to: body.endTime ?? now, rows: cut.rows.length };
    }
    const file = fixtureName(body);
    io.write(join(dir, file), fileText);
    bytes += fileText.length;
    entries.push({ file, type: body.type, request: body, recordedAt: new Date(io.now()).toISOString(), bytes: fileText.length,
      ...(Array.isArray(parsed) ? { rows: parsed.length } : {}), ...(coverage ? { coverage } : {}), ...(truncated ? { truncated } : {}) });
    return parsed;
  };
  const dexes = await save({ type: "perpDexs" });
  const dexNames = Array.isArray(dexes) ? dexes.flatMap((d, i) => (i > 0 && d && typeof d.name === "string" ? [d.name] : [])) : [];
  for (const type of ["spotMeta", "allPerpMetas", "meta", "metaAndAssetCtxs"]) await save({ type });
  for (const user of addresses) {
    for (const type of ["userRole", "userAbstraction", "userDexAbstraction", "spotClearinghouseState", "userFees"]) await save({ type, user });
    const main = await save({ type: "clearinghouseState", user });
    for (const dex of dexNames) await save({ type: "clearinghouseState", user, dex });
    await save({ type: "frontendOpenOrders", user });
    const fills = await save({ type: "userFillsByTime", user, startTime, endTime: now, aggregateByTime: false });
    const twaps = await save({ type: "userTwapSliceFillsByTime", user, startTime, endTime: now });
    await save({ type: "userFunding", user, startTime, endTime: now });
    const newest = Array.isArray(fills) && fills.length ? fills[fills.length - 1] : Array.isArray(twaps) && twaps.length ? twaps[twaps.length - 1].fill : null;
    const coin = newest?.coin ?? main?.assetPositions?.[0]?.position?.coin;
    if (typeof coin === "string" && coin.length > 0 && coin.length <= 80) await save({ type: "activeAssetData", user, coin });
    if (newest && Number.isSafeInteger(newest.oid)) await save({ type: "orderStatus", user, oid: newest.oid });
    await save({ type: "orderStatus", user, oid: 1 });
  }
  const index = mergeIndex(io.read?.(join(dir, "index.json")) ?? null,
    { network, endpoint, date, recordedAt: new Date(now).toISOString(), window: { startTime, endTime: now, hours }, maxFills, addresses, totalBytes: bytes, entries });
  io.write(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  return { dir, index, overBudget: index.totalBytes > SIZE_BUDGET };
}

/** A run into a directory that already holds a recording replaces the files it
 * rewrote and keeps the rest (another address recorded earlier that day). */
export function mergeIndex(existingText, fresh) {
  if (!existingText) return fresh;
  const existing = JSON.parse(existingText);
  if (existing.network !== fresh.network || existing.date !== fresh.date) throw new Error("index.json in the target directory is for another network or date");
  const rewritten = new Set(fresh.entries.map((e) => e.file));
  const entries = [...existing.entries.filter((e) => !rewritten.has(e.file)), ...fresh.entries];
  return { ...fresh, addresses: [...new Set([...existing.addresses, ...fresh.addresses])], totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0), entries,
    runs: [...(existing.runs ?? [{ recordedAt: existing.recordedAt, window: existing.window, addresses: existing.addresses }]), { recordedAt: fresh.recordedAt, window: fresh.window, addresses: fresh.addresses }] };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.exclude) {
    const refused = excluded(options.addresses, parseExclusions(readFileSync(options.exclude, "utf8")));
    if (refused.length) throw new Error(`refusing to record excluded address(es): ${refused.join(", ")}`);
  }
  const result = await record(options, { fetch, sleep: (ms) => sleep(ms), now: Date.now,
    read: (path) => { try { return readFileSync(path, "utf8"); } catch { return null; } },
    write: (path, text) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); } });
  for (const entry of result.index.entries) process.stdout.write(`${entry.file} ${entry.bytes} B${entry.rows !== undefined ? ` ${entry.rows} rows` : ""}${entry.truncated ? ` (kept ${entry.truncated.keptRows} of ${entry.truncated.originalRows})` : ""}\n`);
  process.stdout.write(`${result.index.entries.length} files, ${result.index.totalBytes} B in ${result.dir}\n`);
  if (result.overBudget) { process.stderr.write(`hl-record: total exceeds ${SIZE_BUDGET} B; lower --max-fills or --hours\n`); process.exit(3); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`hl-record: ${error instanceof Error ? error.message : String(error)}\n`); process.exit(error?.message?.startsWith("refusing") ? 2 : 1); });
}
