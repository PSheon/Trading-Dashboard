import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { excluded, fixtureName, mergeIndex, parseArgs, parseExclusions, record, truncateRows, WINDOWED_TYPES } from "./hl-record.mjs";

const leader = "0x77375a8c9d13bf79afb2a87f1b0ac1dfd5f5bf66", ours = "0x4c6d679eac539bf7c5a0b7ebd8949ae93b1e5ee9";

test("arguments: network and at least one address are required, addresses are lower-cased and de-duplicated", () => {
  const parsed = parseArgs(["--network", "mainnet", "--address", leader.toUpperCase().replace("0X", "0x"), "--address", `${leader},${ours}`, "--hours=6", "--max-fills", "100"]);
  assert.deepEqual(parsed.addresses, [leader, ours]);
  assert.equal(parsed.hours, 6); assert.equal(parsed.maxFills, 100); assert.equal(parsed.network, "mainnet");
  assert.throws(() => parseArgs(["--address", leader]), /--network/);
  assert.throws(() => parseArgs(["--network", "mainnet"]), /--address/);
  assert.throws(() => parseArgs(["--network", "mainnet", "--address", "0x123"]), /not an address/);
  assert.throws(() => parseArgs(["--network", "devnet", "--address", leader]), /--network/);
  assert.throws(() => parseArgs(["--network", "mainnet", "--address", leader, "--max-fills", "0"]), /--max-fills/);
});

test("an exclude file refuses our own accounts whatever their case, comments and blank lines ignored", () => {
  const exclusions = parseExclusions(`# our follower accounts\n${ours.toUpperCase().replace("0X", "0x")}   # stage follower\n\n`);
  assert.deepEqual(excluded([leader, ours], exclusions), [ours]);
  assert.deepEqual(excluded([leader], exclusions), []);
});

test("fixture names: type, address prefix and a sanitised dex / coin / oid qualifier", () => {
  assert.equal(fixtureName({ type: "perpDexs" }), "perpDexs.json");
  assert.equal(fixtureName({ type: "clearinghouseState", user: leader }), "clearinghouseState-77375a8c.json");
  assert.equal(fixtureName({ type: "clearinghouseState", user: leader, dex: "xyz" }), "clearinghouseState-77375a8c-xyz.json");
  assert.equal(fixtureName({ type: "activeAssetData", user: leader, coin: "xyz:MU/USD" }), "activeAssetData-77375a8c-xyz_MU_USD.json");
  assert.equal(fixtureName({ type: "orderStatus", user: leader, oid: 583575700359 }), "orderStatus-77375a8c-583575700359.json");
});

test("a long list keeps its newest rows only and says so; a short one is untouched", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({ time: i }));
  assert.deepEqual(truncateRows(rows, 3), { rows: rows.slice(4), truncated: { originalRows: 7, keptRows: 3 } });
  assert.deepEqual(truncateRows(rows, 7), { rows, truncated: null });
  assert.deepEqual(truncateRows({ not: "a list" }, 3), { rows: { not: "a list" }, truncated: null });
});

/** A fake provider: every answer is a tiny valid shape; the fills list is 6 rows a minute apart. */
function fakeProvider() {
  const calls = [], now = 1_792_755_000_000;
  const answers = (body) => {
    switch (body.type) {
      case "perpDexs": return [null, { name: "xyz" }];
      case "clearinghouseState": return { assetPositions: body.dex ? [] : [{ type: "oneWay", position: { coin: "NEAR", szi: "5725926.4000000004" } }], time: now };
      case "userFillsByTime": return Array.from({ length: 6 }, (_, i) => ({ time: now - (6 - i) * 60_000, oid: 100 + i, tid: i, coin: "NEAR", hash: `0x${"0".repeat(64)}`, crossed: false }));
      case "userTwapSliceFillsByTime": case "userFunding": case "frontendOpenOrders": return [];
      case "orderStatus": return body.oid === 105 ? { status: "order", order: {} } : { status: "unknownOid" };
      default: return { type: body.type };
    }
  };
  const io = { now: () => now, sleep: async (ms) => { calls.push(["sleep", ms]); }, read: () => null,
    fetch: async (url, init) => { const body = JSON.parse(init.body); calls.push(["post", body]); return new Response(JSON.stringify(answers(body)), { status: 200 }); },
    write: (path, text) => { calls.push(["write", path, text]); } };
  return { io, calls, now };
}

test("a recording asks only the info endpoint, one request at a time with a pause, and writes the bytes it received plus an index", async () => {
  const { io, calls, now } = fakeProvider();
  const options = parseArgs(["--network", "mainnet", "--address", leader, "--hours", "1", "--max-fills", "4", "--out", "/fixtures", "--date", "2026-10-23"]);
  const result = await record(options, io);
  const posts = calls.filter(([kind]) => kind === "post").map(([, body]) => body);
  const types = posts.map((b) => b.type);
  assert.deepEqual(types.slice(0, 5), ["perpDexs", "spotMeta", "allPerpMetas", "meta", "metaAndAssetCtxs"]);
  assert.deepEqual(posts.filter((b) => b.type === "clearinghouseState").map((b) => b.dex ?? ""), ["", "xyz"], "the main dex and every listed dex");
  assert.deepEqual(posts.filter((b) => b.type === "orderStatus").map((b) => b.oid), [105, 1], "the newest fill's order and an order never placed");
  assert.deepEqual(posts.find((b) => b.type === "activeAssetData"), { type: "activeAssetData", user: leader, coin: "NEAR" });
  const fills = posts.find((b) => b.type === "userFillsByTime");
  assert.deepEqual(fills, { type: "userFillsByTime", user: leader, startTime: now - 3600_000, endTime: now, aggregateByTime: false });
  assert.equal(calls.filter(([kind]) => kind === "sleep").length, posts.length - 1, "a pause between requests");
  assert.ok(posts.every((b) => !("signature" in b) && !("action" in b)), "read only");
  const writes = calls.filter(([kind]) => kind === "write");
  assert.equal(result.dir, join("/fixtures", "mainnet", "2026-10-23"));
  assert.ok(writes.every(([, path]) => path.startsWith(result.dir)));
  const fillsWrite = writes.find(([, path]) => path.endsWith("userFillsByTime-77375a8c.json"));
  assert.equal(JSON.parse(fillsWrite[2]).length, 4, "truncated to the newest --max-fills rows");
  const index = JSON.parse(writes.at(-1)[2]);
  assert.deepEqual(index.addresses, [leader]);
  const fillsEntry = index.entries.find((e) => e.type === "userFillsByTime");
  assert.deepEqual(fillsEntry.truncated, { originalRows: 6, keptRows: 4 });
  assert.deepEqual(fillsEntry.coverage, { from: now - 4 * 60_000, to: now, rows: 4 }, "coverage narrows to the kept rows");
  assert.deepEqual(index.entries.find((e) => e.type === "userFunding").coverage, { from: now - 3600_000, to: now, rows: 0 });
  for (const entry of index.entries) if (!WINDOWED_TYPES.includes(entry.type)) assert.equal(entry.truncated, undefined, `${entry.type} is never truncated`);
  const exact = writes.find(([, path]) => path.endsWith("clearinghouseState-77375a8c.json"));
  assert.equal(exact[2], JSON.stringify({ assetPositions: [{ type: "oneWay", position: { coin: "NEAR", szi: "5725926.4000000004" } }], time: now }), "the bytes as received");
  assert.equal(index.totalBytes, index.entries.reduce((sum, e) => sum + e.bytes, 0));
});

test("a provider error stops the recording instead of writing a partial answer", async () => {
  const { io } = fakeProvider();
  io.fetch = async () => new Response("rate limited", { status: 429 });
  await assert.rejects(record(parseArgs(["--network", "testnet", "--address", leader]), io), /perpDexs answered HTTP 429/);
});

test("a second run into the same day's directory replaces the files it rewrote and keeps the other address's", () => {
  const first = { network: "mainnet", date: "2026-10-23", recordedAt: "a", window: { startTime: 1, endTime: 2, hours: 1 }, maxFills: 500, addresses: [leader], totalBytes: 30,
    entries: [{ file: "perpDexs.json", type: "perpDexs", request: { type: "perpDexs" }, bytes: 10 }, { file: "userRole-77375a8c.json", type: "userRole", request: { type: "userRole", user: leader }, bytes: 20 }] };
  const second = { ...first, recordedAt: "b", addresses: [ours], totalBytes: 16,
    entries: [{ file: "perpDexs.json", type: "perpDexs", request: { type: "perpDexs" }, bytes: 11 }, { file: "userRole-4c6d679e.json", type: "userRole", request: { type: "userRole", user: ours }, bytes: 5 }] };
  const merged = mergeIndex(JSON.stringify(first), second);
  assert.deepEqual(merged.entries.map((e) => [e.file, e.bytes]), [["userRole-77375a8c.json", 20], ["perpDexs.json", 11], ["userRole-4c6d679e.json", 5]]);
  assert.deepEqual(merged.addresses, [leader, ours]); assert.equal(merged.totalBytes, 36); assert.equal(merged.runs.length, 2);
  assert.throws(() => mergeIndex(JSON.stringify({ ...first, date: "2026-10-22" }), second), /another network or date/);
  assert.equal(mergeIndex(null, second), second);
});
