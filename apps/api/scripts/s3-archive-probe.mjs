// Read-only probe of Hyperliquid's node archive: confirms what
// docs/s3-archive-ingest.md still marks "unverified" before the ingest is
// switched on. Needs the compiled api (`pnpm --filter @trading-dashboard/api build`)
// and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment.
//
//   node scripts/s3-archive-probe.mjs            # listings only (LIST requests, ~US$0.00)
//   node scripts/s3-archive-probe.mjs --sample   # also downloads ONE hourly object (~35–100 MB, < US$0.02)
//
// Prints: top-level prefixes, the first and last day of each fills prefix,
// one day's 24 object sizes, the newest object's age (publication lag) and,
// with --sample, the parsed line shape and fill counts of that object.
import { S3ArchiveStore } from "../dist/ingest/archive-store.js";
import { parseArchiveLine, fillStream } from "../dist/ingest/archive-format.js";
import { decodeLz4Frames, splitLines } from "../dist/ingest/lz4-frame.js";

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are required");
  process.exit(1);
}
const store = new S3ArchiveStore({
  bucket: process.env.S3_ARCHIVE_BUCKET ?? "hl-mainnet-node-data",
  region: process.env.S3_ARCHIVE_REGION ?? "ap-northeast-1",
  credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SESSION_TOKEN },
});
const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(3)} GiB`;

const top = await store.list("", { delimiter: "/" });
console.log("top-level prefixes:", top.prefixes.join(" "));

let newest;
for (const prefix of ["node_fills/hourly/", "node_fills_by_block/hourly/", "node_trades/hourly/"]) {
  const days = [];
  let startAfter;
  for (;;) {
    const page = await store.list(prefix, { delimiter: "/", startAfter });
    days.push(...page.prefixes);
    if (!page.truncated || page.prefixes.length === 0) break;
    startAfter = page.prefixes.at(-1);
  }
  console.log(`${prefix}: ${days.length} days, first ${days[0] ?? "-"}, last ${days.at(-1) ?? "-"}`);
  if (days.length === 0) continue;
  for (const day of [days[0], days[Math.floor(days.length / 2)], days.at(-1)]) {
    const { keys } = await store.list(day);
    const total = keys.reduce((sum, key) => sum + key.size, 0);
    console.log(`  ${day} ${keys.length} objects, ${gib(total)}; hours: ${keys.map((key) => key.key.split("/").at(-1)).join(" ")}`);
    const last = keys.sort((a, b) => a.lastModified.localeCompare(b.lastModified)).at(-1);
    if (prefix.startsWith("node_fills_by_block") && day === days.at(-1) && last) newest = last;
  }
}
if (newest) {
  const [, day, file] = /hourly\/(\d{8})\/(\d+)\.lz4$/.exec(newest.key) ?? [];
  const hourEnd = day ? Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8), +file + 1) : NaN;
  console.log(`newest object ${newest.key}: ${newest.size} bytes, uploaded ${newest.lastModified}`);
  console.log(`  upload happened ${((Date.parse(newest.lastModified) - hourEnd) / 60000).toFixed(1)} min after its hour ended; now ${((Date.now() - hourEnd) / 60000).toFixed(1)} min after`);
}

if (process.argv.includes("--sample") && newest) {
  const object = await store.open(newest.key);
  let lines = 0, fills = 0, twap = 0, first;
  let minTime = Infinity, maxTime = -Infinity;
  const addresses = new Set();
  for await (const line of splitLines(decodeLz4Frames(object.body))) {
    lines += 1;
    first ??= line.slice(0, 600);
    for (const { address, fill } of parseArchiveLine(line)) {
      fills += 1;
      if (fillStream(fill) === "twap") twap += 1;
      addresses.add(address);
      minTime = Math.min(minTime, fill.time);
      maxTime = Math.max(maxTime, fill.time);
    }
  }
  console.log(`sample ${newest.key}: ${lines} lines, ${fills} fills (${twap} with twapId), ${addresses.size} addresses`);
  console.log(`  fill times ${new Date(minTime).toISOString()} … ${new Date(maxTime).toISOString()} (compare with the hour in the key: boundary margin)`);
  console.log(`  first line: ${first}`);
}
