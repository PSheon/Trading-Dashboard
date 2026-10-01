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
 * NOT verified first-hand yet (no AWS credentials when this was written):
 * the exact first day, the un-padded hour in the key, and the legacy
 * `node_fills` line shape. `parseArchiveLine` therefore accepts every shape
 * those sources describe and throws on anything else, so a wrong assumption
 * stops the cursor instead of storing wrong fills.
 */
export const ARCHIVE_BUCKET = "hl-mainnet-node-data";
export const ARCHIVE_REGION = "ap-northeast-1";
export const HOUR_MS = 3_600_000;
/** First hour of `node_fills` (legacy, one event per line). */
export const ARCHIVE_FIRST_HOUR = Date.UTC(2025, 4, 25);
/** First hour of `node_fills_by_block` (one block per line). */
export const BY_BLOCK_FIRST_HOUR = Date.UTC(2025, 6, 27);

export const floorHour = (time: number) => Math.floor(time / HOUR_MS) * HOUR_MS;

/** Object key of the hourly fills file starting at `hour` (UTC, epoch ms). */
export function archiveKey(hour: number): string {
  if (hour % HOUR_MS !== 0) throw new Error("Archive hours start on the hour");
  const date = new Date(hour);
  const day = `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
  const prefix = hour >= BY_BLOCK_FIRST_HOUR ? "node_fills_by_block" : "node_fills";
  return `${prefix}/hourly/${day}/${date.getUTCHours()}.lz4`;
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
