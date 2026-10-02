import { createReadStream, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { auditFills, duplicateTids, lifetimeComplete, pnlIdentity, positionBreaks, reconcileFills } from "../src/analytics/fill-integrity.js";
import { advanceCheckpoint, ARCHIVE_BOUNDARY_MARGIN_MS, certifiedSpan, initialCheckpoint, planRange } from "../src/analytics/history-checkpoint.js";
import { applyFills, type Trade } from "../src/analytics/trade-reconstruction.js";
import type { HlUserFill } from "../src/hyperliquid/types.js";
import { ARCHIVE_FIRST_HOUR, archiveKey, archiveKeys, backfillFloor, ArchiveFormatError, BY_BLOCK_FIRST_HOUR, fillStream, parseArchiveLine } from "../src/ingest/archive-format.js";
import { signS3Request } from "../src/ingest/archive-store.js";
import { decodeLz4Frames, Lz4FormatError, splitLines, XxHash32 } from "../src/ingest/lz4-frame.js";
import { storedFrame } from "./archive-test-utils.js";

const FIXTURES = new URL("./fixtures/archive/", import.meta.url);
const fixture = (hour: number) => new URL(`node_fills_by_block/hourly/20260925/${hour}.lz4`, FIXTURES);
const expected = JSON.parse(readFileSync(new URL("expected.json", FIXTURES), "utf8")) as Record<string, HlUserFill[]>;
const HOUR_11 = Date.UTC(2026, 8, 25, 11);

async function* once(buffer: Buffer, chunk = 7_919): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buffer.length; i += chunk) yield buffer.subarray(i, i + chunk);
}
async function fillsOf(source: AsyncIterable<Uint8Array>) {
  const out = [];
  for await (const line of splitLines(decodeLz4Frames(source))) out.push(...parseArchiveLine(line));
  return out;
}
describe("LZ4 frame decoder", () => {
  it("matches xxHash32 reference values", () => {
    expect(new XxHash32().digest()).toBe(0x02cc5d05);
    expect(new XxHash32().update(Buffer.from("abc")).digest()).toBe(0x32d153ff);
    const long = Buffer.from("Nobody inspects the spammish repetition");
    expect(new XxHash32().update(long).digest()).toBe(0xe2293b2f);
    // Split updates give the same digest as one.
    expect(new XxHash32().update(long.subarray(0, 5)).update(long.subarray(5, 21)).update(long.subarray(21)).digest()).toBe(0xe2293b2f);
  });

  it.each([[11, "independent 4 MiB blocks"], [12, "linked 64 KiB blocks"]])("decodes the hour-%i fixture written by the lz4 CLI (%s), checksum verified", async (hour) => {
    const entries = await fillsOf(createReadStream(fixture(hour)));
    const tracked = entries.filter((entry) => entry.address in expected);
    const start = HOUR_11 + (hour - 11) * 3_600_000;
    const want = Object.entries(expected).flatMap(([address, fills]) => fills
      .filter((fill) => fill.time >= start && fill.time < start + 3_600_000).map((fill) => ({ address, tid: fill.tid })));
    expect(tracked).toHaveLength(want.length);
    // Each trade is present twice: the tracked side and its counterparty.
    expect(entries).toHaveLength(want.length * 2);
    for (const { address, fill } of tracked) {
      const rest = expected[address].find((candidate) => candidate.tid === fill.tid)!;
      expect(reconcileFills([fill], [rest]).exact).toBe(true);
    }
  });

  it("gives the same output whatever the chunking", async () => {
    const bytes = readFileSync(fixture(12));
    const whole = await fillsOf(once(bytes, bytes.length));
    for (const size of [1, 13, 4096]) expect(await fillsOf(once(bytes, size))).toEqual(whole);
  }, 30_000);

  it("rejects a corrupted, truncated or foreign stream instead of yielding data", async () => {
    const bytes = Buffer.from(readFileSync(fixture(11)));
    const corrupted = Buffer.from(bytes);
    corrupted[corrupted.length - 2] ^= 0xff; // content checksum
    await expect(fillsOf(once(corrupted))).rejects.toThrow(Lz4FormatError);
    await expect(fillsOf(once(bytes.subarray(0, bytes.length - 9)))).rejects.toThrow(Lz4FormatError);
    await expect(fillsOf(once(Buffer.from("{\"events\":[]}\n")))).rejects.toThrow(Lz4FormatError);
    await expect(fillsOf(once(Buffer.alloc(0)))).rejects.toThrow(Lz4FormatError);
  });

  it("reads stored blocks and concatenated frames", async () => {
    const line = (tid: number) => JSON.stringify({ events: [["0x" + "ab".repeat(20), { ...expected[Object.keys(expected)[0]][0], tid }]] });
    const entries = await fillsOf(once(Buffer.concat([storedFrame(`${line(1)}\n${line(2)}\n`), storedFrame(line(3))])));
    expect(entries.map((entry) => entry.fill.tid)).toEqual([1, 2, 3]);
  });
});

describe("archive layout and line formats", () => {
  it("names hourly objects by UTC day and unpadded hour, switching prefix inside 2025-07-27 08:00", () => {
    // As listed in the bucket on 2026-10-02.
    expect(archiveKey(ARCHIVE_FIRST_HOUR)).toBe("node_fills/hourly/20250525/14.lz4");
    expect(archiveKeys(BY_BLOCK_FIRST_HOUR - 3_600_000)).toEqual(["node_fills/hourly/20250727/7.lz4"]);
    // The hour of the change is split between both prefixes: both are read.
    expect(archiveKeys(BY_BLOCK_FIRST_HOUR)).toEqual(["node_fills/hourly/20250727/8.lz4", "node_fills_by_block/hourly/20250727/8.lz4"]);
    expect(archiveKeys(BY_BLOCK_FIRST_HOUR + 3_600_000)).toEqual(["node_fills_by_block/hourly/20250727/9.lz4"]);
    expect(archiveKey(BY_BLOCK_FIRST_HOUR)).toBe("node_fills_by_block/hourly/20250727/8.lz4");
    expect(archiveKey(HOUR_11)).toBe("node_fills_by_block/hourly/20260925/11.lz4");
    expect(() => archiveKey(HOUR_11 + 1)).toThrow();
  });

  it("the backfill window is whole UTC days back from now, never before the configured start or the archive's first hour", () => {
    const now = Date.UTC(2026, 9, 2, 10, 30);
    const start = Date.UTC(2025, 4, 25);
    expect(backfillFloor(now, start, 90)).toBe(Date.UTC(2026, 6, 4));
    // The same all day; one day later the next morning.
    expect(backfillFloor(Date.UTC(2026, 9, 2, 23, 59), start, 90)).toBe(Date.UTC(2026, 6, 4));
    expect(backfillFloor(Date.UTC(2026, 9, 3), start, 90)).toBe(Date.UTC(2026, 6, 5));
    // 90 days never reach the 2025-07-27 format change; a longer window does.
    expect(backfillFloor(now, start, 90)).toBeGreaterThan(BY_BLOCK_FIRST_HOUR);
    expect(backfillFloor(now, start, 450)).toBeLessThan(BY_BLOCK_FIRST_HOUR);
    expect(backfillFloor(now, start, 3650)).toBe(ARCHIVE_FIRST_HOUR);
    expect(backfillFloor(now, Date.UTC(2026, 8, 1), 90)).toBe(Date.UTC(2026, 8, 1));
  });

  const sample = { coin: "BTC", px: "118136.0", sz: "0.00009", side: "B", time: 1753606210273, startPosition: "-1.41864", dir: "Close Short",
    closedPnl: "-0.003753", hash: "0xe782", oid: 121670079265, crossed: false, fee: "-0.000212", tid: 161270588369408,
    cloid: "0x09367b9f8541c581f95b02aaf05f1508", feeToken: "USDC", twapId: null };
  const address = "0x7839E2f2c375dd2935193f2736167514efff9916";

  it("parses the by-block envelope and both legacy one-event shapes", () => {
    const block = parseArchiveLine(JSON.stringify({ local_time: "2025-07-27T08:50:10.334741319", block_time: "2025-07-27T08:50:10.273720809",
      block_number: 676607012, events: [[address, sample], [address.toLowerCase(), { ...sample, tid: 2, twapId: 77 }]] }));
    expect(block.map((entry) => [entry.address, entry.fill.tid, fillStream(entry.fill)])).toEqual([
      [address.toLowerCase(), 161270588369408, "regular"], [address.toLowerCase(), 2, "twap"]]);
    // Unknown fields survive for the raw payload.
    expect((block[0].fill as unknown as { cloid: string }).cloid).toBe(sample.cloid);
    expect(parseArchiveLine(JSON.stringify([address, sample]))[0].fill.px).toBe("118136.0");
    expect(parseArchiveLine(JSON.stringify({ user: address, ...sample }))[0]).toMatchObject({ address: address.toLowerCase(), fill: { tid: sample.tid } });
    expect(parseArchiveLine(JSON.stringify({ events: [] }))).toEqual([]);
  });

  it("stops on anything it does not recognise", () => {
    for (const line of ["not json", "{}", "[1,2,3]", JSON.stringify({ events: [[address]] }), JSON.stringify([address, { ...sample, px: "abc" }]),
      JSON.stringify([address, { ...sample, tid: 2 ** 60 }]), JSON.stringify(["0x12", sample]), JSON.stringify([address, { ...sample, side: "X" }])]) {
      expect(() => parseArchiveLine(line), line).toThrow(ArchiveFormatError);
    }
  });
});

describe("S3 request signing (AWS documentation examples)", () => {
  const credentials = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" };
  const base = { host: "examplebucket.s3.amazonaws.com", region: "us-east-1", credentials, now: new Date("2013-05-24T00:00:00Z"), method: "GET" as const };

  it("signs GET Object", () => {
    const headers = signS3Request({ ...base, path: "/test.txt", headers: { range: "bytes=0-9" } });
    expect(headers.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,"
      + "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
    expect(headers.host).toBeUndefined();
  });

  it("signs a bucket listing", () => {
    const headers = signS3Request({ ...base, path: "/", query: { "max-keys": "2", prefix: "J" } });
    expect(headers.authorization).toContain("Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7");
  });
});

describe("REST ranges around an archive-certified span", () => {
  const fill = (tid: number, time = tid): HlUserFill => ({ tid, time, coin: "BTC", px: "100", sz: "1", side: "B", startPosition: "0", closedPnl: "0",
    dir: "Open Long", hash: "0x1", oid: tid, crossed: true, fee: "0" });

  it("certifies ingested hours minus a margin on both sides", () => {
    const span = certifiedSpan(new Date(HOUR_11), new Date(HOUR_11 + 7_200_000))!;
    expect(span).toEqual({ from: HOUR_11 + ARCHIVE_BOUNDARY_MARGIN_MS, through: HOUR_11 + 7_200_000 - ARCHIVE_BOUNDARY_MARGIN_MS });
    expect(certifiedSpan(null, new Date())).toBeNull();
    expect(certifiedSpan(new Date(HOUR_11), new Date(HOUR_11 + 2 * ARCHIVE_BOUNDARY_MARGIN_MS))).toBeNull();
  });

  it("reads before the span, jumps over it without a request, then reads the tail", () => {
    const span = { from: 1_000, through: 9_000 };
    let checkpoint = initialCheckpoint(10_000);
    const first = planRange(checkpoint, "regular", span);
    expect([first.start, first.end]).toEqual([0, 999]);
    // A short page before the span completes only up to it.
    checkpoint = advanceCheckpoint(first.checkpoint, "regular", [fill(1, 500)], first.end!);
    expect(checkpoint.sources.regular).toEqual({ cursor: 1_000, through: 999, status: "pending" });
    const second = planRange(checkpoint, "regular", span);
    expect([second.start, second.end]).toEqual([9_000, 10_000]);
    expect(second.checkpoint.sources.regular.through).toBe(8_999);
    checkpoint = advanceCheckpoint(second.checkpoint, "regular", [fill(2, 9_500)], second.end!);
    expect(checkpoint.sources.regular).toEqual({ cursor: 10_000, through: 10_000, status: "complete" });
    // Without a span the plan is the original full range.
    expect(planRange(initialCheckpoint(10_000), "regular", null)).toMatchObject({ start: 0, end: 10_000 });
  });

  it("completes without any request when the span reaches past the cutoff", () => {
    const plan = planRange(initialCheckpoint(10_000, 2_000), "regular", { from: 1_000, through: 20_000 });
    expect(plan.start).toBeNull();
    expect(plan.checkpoint.sources.regular).toEqual({ cursor: 10_000, through: 10_000, status: "complete" });
  });

  it("refuses a fill beyond the requested end, and keeps full-page rules before the span", () => {
    const plan = planRange(initialCheckpoint(10_000), "regular", { from: 5_000, through: 9_000 });
    expect(() => advanceCheckpoint(plan.checkpoint, "regular", [fill(1, 5_500)], plan.end!)).toThrow("outside history request bounds");
    const page = Array.from({ length: 2000 }, (_, i) => fill(i + 1, 1 + i));
    expect(advanceCheckpoint(plan.checkpoint, "regular", page, plan.end!).sources.regular).toEqual({ cursor: 2_000, through: 1_999, status: "pending" });
  });
});

describe("fill integrity", () => {
  const address = Object.keys(expected)[0];

  it("real fills hold the invariants: unique tids, continuous positions, PnL identity", () => {
    for (const [owner, fills] of Object.entries(expected)) {
      const audit = auditFills(owner, fills);
      expect(audit.duplicateTids, owner).toEqual([]);
      expect(audit.positionBreaks, owner).toEqual([]);
      expect(audit.pnl.holds, owner).toBe(true);
    }
  });

  it("a missing fill breaks the position chain where it was", () => {
    const fills = [...expected[address]].sort((a, b) => a.time - b.time);
    const coin = fills[0].coin;
    const sameCoin = fills.filter((fill) => fill.coin === coin);
    const removed = sameCoin[Math.floor(sameCoin.length / 2)];
    const breaks = positionBreaks(fills.filter((fill) => fill !== removed));
    expect(breaks.length).toBeGreaterThan(0);
    expect(breaks[0].coin).toBe(coin);
    expect(breaks[0].time).toBeGreaterThanOrEqual(removed.time);
  });

  it("reports duplicates and keeps the PnL identity against double counting", () => {
    const fills = expected[address];
    expect(duplicateTids([...fills, fills[3]])).toEqual([fills[3].tid]);
    expect(pnlIdentity(address, [...fills, fills[3]]).holds).toBe(true);
    const total = fills.reduce((sum, fill) => sum + Number(fill.closedPnl), 0);
    expect(pnlIdentity(address, fills).fillsPnl).toBeCloseTo(total, 6);
  });

  it("reconciles tid by tid: missing fills and differing fields are named", () => {
    const left = expected[address];
    expect(reconcileFills(left, left.map((fill) => ({ ...fill, px: `${fill.px}0` })))).toMatchObject({ exact: true, onlyLeft: [], onlyRight: [] });
    const right = left.slice(1).map((fill, index) => index === 0 ? { ...fill, fee: "9.99" } : fill);
    const result = reconcileFills(left, right);
    expect(result.exact).toBe(false);
    expect(result.onlyLeft).toEqual([left[0].tid]);
    expect(result.mismatches).toEqual([{ tid: left[1].tid, field: "fee", left: left[1].fee, right: "9.99" }]);
    expect(result.left.count - result.right.count).toBe(1);
  });

  it("calls history complete only when nothing can be missing", () => {
    const open = (tid: number, startPosition: string, sz = "1"): HlUserFill => ({ tid, time: tid, coin: "ETH", px: "10", sz, side: "B", startPosition,
      closedPnl: "0", dir: "Open Long", hash: "0x1", oid: tid, crossed: true, fee: "0" });
    const result = (fills: HlUserFill[]) => applyFills(address, new Map<string, Trade>(), fills, null);
    const whole = [open(1, "0"), open(2, "1")];
    expect(lifetimeComplete(whole, result(whole))).toBe(true);
    // Position already open at the first fill held: partial.
    const partial = [open(1, "5")];
    expect(lifetimeComplete(partial, result(partial))).toBe(false);
    // A gap in the chain: partial.
    const gap = [open(1, "0"), open(3, "2")];
    expect(lifetimeComplete(gap, result(gap))).toBe(false);
    // At upstream's retention size nothing proves older fills were not cut.
    const many = Array.from({ length: 10_000 }, (_, i) => open(i + 1, String(i)));
    expect(lifetimeComplete(many, result(many))).toBe(false);
  });
});
