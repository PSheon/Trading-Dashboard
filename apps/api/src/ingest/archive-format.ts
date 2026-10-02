import type { HlUserFill } from "../hyperliquid/types.js";

/**
 * Layout and line formats of Hyperliquid's public node archive
 * (`s3://hl-mainnet-node-data`, requester-pays, ap-northeast-1).
 *
 * Sources: the official "Historical data" page (prefixes; `node_fills_by_block`
 * is `--write-fills --batch-by-block` output; `node_fills` "matches the API
 * format"), the node README (`{local_time, block_time, block_number, events}`
 * per line when batched by block; one event per line otherwise) and
 * bond-labs/hyperliquid-data (key shape `hourly/<YYYYMMDD>/<H>.lz4`, the
 * 2025-05-25 start and the 2025-07-27 format change).
 *
 * Checked against the bucket on 2026-10-02 (listings, two by-block objects
 * and one legacy object): the hour is not zero-padded; `node_fills` runs
 * from 2025-05-25 14:00 to 2025-07-27 08:45 UTC, one `[address, fill]` per
 * line, without `twapId`; `node_fills_by_block` starts inside that same
 * hour (`20250727/8.lz4` exists under both prefixes, the by-block one
 * holding only the rest of the hour). `parseArchiveLine` still accepts
 * every shape the sources describe and throws on anything else, so a
 * wrong assumption stops the cursor instead of storing wrong fills.
 */
export const ARCHIVE_BUCKET = "hl-mainnet-node-data";
export const ARCHIVE_REGION = "ap-northeast-1";
export const HOUR_MS = 3_600_000;
/** First hour of `node_fills` (legacy, one event per line). */
export const ARCHIVE_FIRST_HOUR = Date.UTC(2025, 4, 25, 14);
/** The hour in which the node switched to `node_fills_by_block` (one block
 * per line): its fills are split between the two prefixes. */
export const BY_BLOCK_FIRST_HOUR = Date.UTC(2025, 6, 27, 8);

export const floorHour = (time: number) => Math.floor(time / HOUR_MS) * HOUR_MS;

const DAY_MS = 24 * HOUR_MS;
/** The hour a backfill pass goes down to: the start of the UTC day `days`
 * days before `now`, never before `start` or the archive's first hour. It
 * moves forward a day at a time, so a span that reached it stays covered. */
export function backfillFloor(now: number, start: number, days: number): number {
  return Math.max(start, ARCHIVE_FIRST_HOUR, Math.floor((now - days * DAY_MS) / DAY_MS) * DAY_MS);
}

function key(prefix: string, hour: number): string {
  if (hour % HOUR_MS !== 0) throw new Error("Archive hours start on the hour");
  const date = new Date(hour);
  const day = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  return `${prefix}/hourly/${day}/${date.getUTCHours()}.lz4`;
}

/** Object key of the hourly fills file starting at `hour` (UTC, epoch ms);
 * for the format-change hour, the by-block one. */
export function archiveKey(hour: number): string {
  return key(hour >= BY_BLOCK_FIRST_HOUR ? "node_fills_by_block" : "node_fills", hour);
}

/** Every object that holds fills of `hour`: one, except the hour of the
 * format change, which needs the legacy file and the by-block file. */
export function archiveKeys(hour: number): string[] {
  return hour === BY_BLOCK_FIRST_HOUR ? [key("node_fills", hour), key("node_fills_by_block", hour)] : [archiveKey(hour)];
}

export interface ArchiveFill {
  /** Lower-case 0x address of the account the fill belongs to. */
  address: string;
  fill: HlUserFill;
}

export class ArchiveFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveFormatError";
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;
const isDecimal = (value: unknown): value is string => typeof value === "string" && value.length <= 128 && DECIMAL.test(value);
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The same field checks the REST client applies to `userFillsByTime`
 * (`response-validation.ts`); unknown fields are kept in the raw payload. */
function toFill(address: unknown, value: unknown): ArchiveFill {
  if (typeof address !== "string" || !ADDRESS.test(address)) throw new ArchiveFormatError("Fill without a valid address");
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new ArchiveFormatError("Fill is not an object");
  const f = value as Record<string, unknown>;
  const valid = typeof f.coin === "string" && f.coin.length > 0 && isDecimal(f.px) && isDecimal(f.sz)
    && (f.side === "A" || f.side === "B") && isId(f.time) && isId(f.tid) && isId(f.oid)
    && isDecimal(f.closedPnl) && isDecimal(f.fee) && typeof f.dir === "string" && typeof f.hash === "string"
    && typeof f.crossed === "boolean" && (f.startPosition === undefined || isDecimal(f.startPosition))
    && (f.twapId === undefined || f.twapId === null || isId(f.twapId));
  if (!valid) throw new ArchiveFormatError("Fill fails field validation");
  return { address: address.toLowerCase(), fill: f as unknown as HlUserFill };
}

/**
 * Fills of one archive line:
 * - by-block: `{"local_time","block_time","block_number","events":[[address, fill], …]}`;
 * - legacy one-event lines: `[address, fill]`, or `{"user": address, …fill}`.
 * @throws ArchiveFormatError on any other shape or an invalid fill.
 */
export function parseArchiveLine(line: string): ArchiveFill[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ArchiveFormatError("Archive line is not JSON");
  }
  if (Array.isArray(value)) {
    if (value.length !== 2) throw new ArchiveFormatError("Event is not an [address, fill] pair");
    return [toFill(value[0], value[1])];
  }
  if (value === null || typeof value !== "object") throw new ArchiveFormatError("Unknown archive line");
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.events)) {
    return object.events.map((event) => {
      if (!Array.isArray(event) || event.length !== 2) throw new ArchiveFormatError("Event is not an [address, fill] pair");
      return toFill(event[0], event[1]);
    });
  }
  if (typeof object.user === "string") {
    const { user, ...fill } = object;
    return [toFill(user, fill)];
  }
  throw new ArchiveFormatError("Unknown archive line");
}

/** Which history stream an archive fill belongs to (a TWAP slice carries its
 * `twapId`; REST serves those from a separate endpoint). */
export const fillStream = (fill: HlUserFill): "regular" | "twap" => (fill.twapId == null ? "regular" : "twap");
