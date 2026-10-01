// Rebuilds the archive fixture (not run by tests). Input: JSON lines of
// {address, source, raw} — real fills as Hyperliquid's REST API returned
// them (public on-chain data) for 2026-09-25 11:00–13:00 UTC. Output, in the
// archive's documented layout and line format (`--write-fills
// --batch-by-block`: one block per line, `events: [[address, fill], …]`):
//   node_fills_by_block/hourly/20260925/11.lz4   lz4 default (independent blocks)
//   node_fills_by_block/hourly/20260925/12.lz4   lz4 -BD -B4 (linked 64 KiB blocks)
//   expected.json                                the REST fills per address
// Each trade appears twice in the real archive (both counterparties, same
// tid); the other side is generated here under synthetic 0x00…NN addresses
// that are never tracked. The archive's own bytes could not be downloaded
// when this was built (no AWS credentials), so the envelope follows the
// node README, not a captured object.
//
//   node build-fixture.mjs rows.jsonl   (needs the `lz4` CLI)
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const rows = readFileSync(process.argv[2], "utf8").trim().split("\n").map((line) => JSON.parse(line));
const HOUR = 3_600_000;
const iso = (ms, nanos) => `${new Date(ms).toISOString().slice(0, 23)}${String(nanos).padStart(6, "0")}`;
const expected = {};
const byHour = new Map();
let noise = 0;
for (const { address, source, raw } of rows) {
  (expected[address] ??= []).push(raw);
  const fill = { ...raw, twapId: source === "twap" ? raw.twapId : null };
  const other = {
    coin: raw.coin, px: raw.px, sz: raw.sz, side: raw.side === "B" ? "A" : "B", time: raw.time, startPosition: "0.0",
    dir: raw.side === "B" ? "Open Short" : "Open Long", closedPnl: "0.0", hash: raw.hash, oid: raw.oid + 1,
    crossed: !raw.crossed, fee: "0.0", tid: raw.tid, feeToken: "USDC", twapId: null,
  };
  const counterparty = `0x${String((noise++ % 40) + 1).padStart(40, "0")}`;
  const hour = Math.floor(raw.time / HOUR) * HOUR;
  const blocks = byHour.get(hour) ?? new Map();
  byHour.set(hour, blocks);
  const events = blocks.get(raw.time) ?? [];
  blocks.set(raw.time, events);
  events.push([address, fill], [counterparty, other]);
}
let blockNumber = 912_000_000;
for (const [hour, blocks] of [...byHour].sort((a, b) => a[0] - b[0])) {
  const date = new Date(hour);
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const path = join(here, "node_fills_by_block", "hourly", day, String(date.getUTCHours()));
  mkdirSync(dirname(path), { recursive: true });
  const lines = [...blocks].sort((a, b) => a[0] - b[0]).map(([time, events]) => JSON.stringify({
    local_time: iso(time + 64, 123456), block_time: iso(time, 0), block_number: blockNumber++, events,
  }));
  writeFileSync(path, `${lines.join("\n")}\n`);
  execFileSync("lz4", ["-f", "--rm", ...(date.getUTCHours() % 2 === 0 ? ["-BD", "-B4"] : []), path, `${path}.lz4`]);
}
writeFileSync(join(here, "expected.json"), `${JSON.stringify(expected)}\n`);
