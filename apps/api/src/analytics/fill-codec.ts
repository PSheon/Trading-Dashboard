import type { HlUserFill } from "../hyperliquid/types.js";

/**
 * Lossless mapping between a Hyperliquid fill (the JSON object of
 * `userFillsByTime`, a TWAP slice or an archive line) and the typed columns
 * of `history_fills`.
 *
 * The contract is exactness: `decodeFill(encodeFill(fill))` equals `fill`
 * value for value, including the decimal strings as Hyperliquid wrote them
 * ("0.0" is not "0"). Each field has one canonical shape that its column
 * reproduces exactly; a value in any other shape — and every key this file
 * does not know — is kept verbatim in `extra` instead, so nothing is ever
 * rounded, normalised or dropped:
 *
 * | Field | Column | Canonical shape (anything else → `extra`) |
 * | --- | --- | --- |
 * | tid, time | bigint, timestamptz | non-negative safe integer (required: they key the row) |
 * | oid | bigint | non-negative safe integer |
 * | twapId | bigint | number as above; JSON null is SQL NULL; a missing key is −1 |
 * | coin, dir, feeToken | term id | any string (dictionary `history_terms`) |
 * | side | boolean | "B" true, "A" false |
 * | crossed | boolean | boolean |
 * | px, sz, startPosition, closedPnl, fee, builderFee, deployerFee, priorityGas | numeric | plain decimal string: Postgres `numeric` keeps the scale, so "1.50" reads back "1.50"; no exponent, leading zeros, "+", "-0" or bare "." |
 * | hash | bytea | 0x + 64 lower-case hex; the all-zero hash (TWAP slices) is the empty string |
 * | cloid | bytea | 0x + 32 lower-case hex |
 * | builder, liquidation.liquidatedUser | bytea | 0x + 40 lower-case hex |
 * | liquidation | 3 columns | object of `method` (string), `markPx` (decimal) and optionally `liquidatedUser`, nothing else |
 *
 * Key order is not part of a JSON value and is not kept (the previous
 * `jsonb` column did not keep it either).
 */
export interface FillColumns {
  tid: bigint;
  time: Date;
  oid: number | null;
  /** NULL: `"twapId": null`. {@link TWAP_ID_ABSENT}: the fill has no such key. */
  twapId: number | null;
  coin: string | null;
  dir: string | null;
  feeToken: string | null;
  sideBuy: boolean | null;
  crossed: boolean | null;
  hash: Buffer | null;
  px: string | null;
  sz: string | null;
  startPosition: string | null;
  closedPnl: string | null;
  fee: string | null;
  cloid: Buffer | null;
  builder: Buffer | null;
  builderFee: string | null;
  deployerFee: string | null;
  priorityGas: string | null;
  liquidatedUser: Buffer | null;
  liquidationMarkPx: string | null;
  /** Not null exactly when the fill carries a `liquidation` held in columns. */
  liquidationMethod: string | null;
  /** Keys without a column, and mapped keys whose value is not canonical. */
  extra: Record<string, unknown> | null;
}

export const TWAP_ID_ABSENT = -1;

export class FillEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FillEncodeError";
  }
}

/** What `numeric` prints back unchanged. The length bound keeps the value
 * far inside numeric's limits (16,383 fraction digits). */
const DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NEGATIVE_ZERO = /^-0(?:\.0+)?$/;
const isDecimal = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && DECIMAL.test(value) && !NEGATIVE_ZERO.test(value);
const isId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
const HEX = { hash: /^0x[0-9a-f]{64}$/, cloid: /^0x[0-9a-f]{32}$/, address: /^0x[0-9a-f]{40}$/ };
const ZERO_HASH = `0x${"0".repeat(64)}`;
const bytes = (hex: string) => Buffer.from(hex.slice(2), "hex");
const hex = (value: Buffer) => `0x${value.toString("hex")}`;

const DECIMALS = [["px", "px"], ["sz", "sz"], ["startPosition", "startPosition"], ["closedPnl", "closedPnl"], ["fee", "fee"],
  ["builderFee", "builderFee"], ["deployerFee", "deployerFee"], ["priorityGas", "priorityGas"]] as const;
const TERMS = ["coin", "dir", "feeToken"] as const;
const LIQUIDATION_KEYS = new Set(["liquidatedUser", "markPx", "method"]);

function liquidationColumns(value: unknown): Pick<FillColumns, "liquidatedUser" | "liquidationMarkPx" | "liquidationMethod"> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !LIQUIDATION_KEYS.has(key))) return null;
  if (typeof object.method !== "string" || !isDecimal(object.markPx)) return null;
  const user = object.liquidatedUser;
  if (user !== undefined && !(typeof user === "string" && HEX.address.test(user))) return null;
  return { liquidatedUser: user === undefined ? null : bytes(user as string), liquidationMarkPx: object.markPx, liquidationMethod: object.method };
}

/**
 * The typed columns of one fill.
 * @throws FillEncodeError when `tid` or `time` cannot key a row.
 */
export function encodeFill(fill: HlUserFill): FillColumns {
  const source = fill as unknown as Record<string, unknown>;
  if (!isId(source.tid)) throw new FillEncodeError("Fill without a usable tid");
  if (!isId(source.time) || source.time > 8.64e15) throw new FillEncodeError("Fill without a usable time");
  const columns: FillColumns = {
    tid: BigInt(source.tid), time: new Date(source.time), oid: null, twapId: TWAP_ID_ABSENT, coin: null, dir: null, feeToken: null,
    sideBuy: null, crossed: null, hash: null, px: null, sz: null, startPosition: null, closedPnl: null, fee: null, cloid: null,
    builder: null, builderFee: null, deployerFee: null, priorityGas: null, liquidatedUser: null, liquidationMarkPx: null,
    liquidationMethod: null, extra: null,
  };
  const extra: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(source)) {
    // An undefined property is not part of the JSON value.
    if (value === undefined || key === "tid" || key === "time") continue;
    let mapped = false;
    if (key === "oid") {
      if ((mapped = isId(value))) columns.oid = value as number;
    } else if (key === "twapId") {
      columns.twapId = null;
      if (isId(value)) columns.twapId = value;
      mapped = value === null || isId(value);
    } else if (key === "coin" || key === "dir" || key === "feeToken") {
      // Postgres text cannot hold U+0000.
      if ((mapped = typeof value === "string" && !value.includes("\u0000"))) columns[key] = value as string;
    } else if (key === "side") {
      if ((mapped = value === "A" || value === "B")) columns.sideBuy = value === "B";
    } else if (key === "crossed") {
      if ((mapped = typeof value === "boolean")) columns.crossed = value as boolean;
    } else if (key === "hash") {
      if ((mapped = typeof value === "string" && HEX.hash.test(value))) columns.hash = value === ZERO_HASH ? Buffer.alloc(0) : bytes(value as string);
    } else if (key === "cloid") {
      if ((mapped = typeof value === "string" && HEX.cloid.test(value))) columns.cloid = bytes(value as string);
    } else if (key === "builder") {
      if ((mapped = typeof value === "string" && HEX.address.test(value))) columns.builder = bytes(value as string);
    } else if (key === "liquidation") {
      const liquidation = liquidationColumns(value);
      if ((mapped = liquidation !== null)) Object.assign(columns, liquidation);
    } else {
      const decimal = DECIMALS.find(([name]) => name === key);
      if (decimal && (mapped = isDecimal(value))) columns[decimal[1]] = value as string;
    }
    if (!mapped) extra.push([key, value]);
  }
  // fromEntries defines own properties, so a key named "__proto__" stays data.
  if (extra.length > 0) columns.extra = Object.fromEntries(extra);
  return columns;
}

/** The fill a row holds: exactly the object {@link encodeFill} was given. */
export function decodeFill(row: FillColumns): HlUserFill {
  const fill: Record<string, unknown> = {};
  if (row.coin !== null) fill.coin = row.coin;
  if (row.px !== null) fill.px = row.px;
  if (row.sz !== null) fill.sz = row.sz;
  if (row.sideBuy !== null) fill.side = row.sideBuy ? "B" : "A";
  fill.time = row.time.getTime();
  if (row.startPosition !== null) fill.startPosition = row.startPosition;
  if (row.dir !== null) fill.dir = row.dir;
  if (row.closedPnl !== null) fill.closedPnl = row.closedPnl;
  if (row.hash !== null) fill.hash = row.hash.length === 0 ? ZERO_HASH : hex(row.hash);
  if (row.oid !== null) fill.oid = Number(row.oid);
  if (row.crossed !== null) fill.crossed = row.crossed;
  if (row.fee !== null) fill.fee = row.fee;
  fill.tid = Number(row.tid);
  if (row.cloid !== null) fill.cloid = hex(row.cloid);
  if (row.liquidationMethod !== null) {
    fill.liquidation = {
      ...(row.liquidatedUser !== null ? { liquidatedUser: hex(row.liquidatedUser) } : {}),
      markPx: row.liquidationMarkPx,
      method: row.liquidationMethod,
    };
  }
  if (row.feeToken !== null) fill.feeToken = row.feeToken;
  if (row.builder !== null) fill.builder = hex(row.builder);
  if (row.builderFee !== null) fill.builderFee = row.builderFee;
  if (row.deployerFee !== null) fill.deployerFee = row.deployerFee;
  if (row.priorityGas !== null) fill.priorityGas = row.priorityGas;
  if (row.twapId === null) fill.twapId = null;
  else if (Number(row.twapId) !== TWAP_ID_ABSENT) fill.twapId = Number(row.twapId);
  for (const [key, value] of Object.entries(row.extra ?? {})) {
    Object.defineProperty(fill, key, { value, enumerable: true, writable: true, configurable: true });
  }
  return fill as unknown as HlUserFill;
}

/** Canonical JSON text (keys sorted at every depth): equal exactly when two
 * JSON values are equal, whatever their key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

/** Value-for-value equality of two fills (strings compare as written). */
export const sameFill = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);

/** Terms (coin, dir, feeToken) a set of rows needs from the dictionary. */
export function termsOf(rows: FillColumns[]): string[] {
  const terms = new Set<string>();
  for (const row of rows) for (const key of TERMS) if (row[key] !== null) terms.add(row[key]!);
  return [...terms];
}
