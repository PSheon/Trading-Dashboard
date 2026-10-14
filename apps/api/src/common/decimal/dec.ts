import { fromUnits, isDecimal, toUnits, type Units } from "../../admin/decimal.js";

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** a ÷ b rounded half away from zero (as Postgres `round(numeric)` does). */
function divRound(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new RangeError("Division by zero");
  const negative = (a < 0n) !== (b < 0n);
  const x = a < 0n ? -a : a;
  const y = b < 0n ? -b : b;
  const q = (x * 2n + y) / (y * 2n);
  return negative ? -q : q;
}

export type DecInput = Dec | string | number | bigint;

/**
 * Immutable exact decimal for money, sizes and prices: a bigint scaled by 10^18 (as in
 * `admin/decimal.ts`).
 * - +, −, comparison exact; ×, ÷ exact to 18 decimals, 19th rounded half away from zero
 *   (HL sizes/prices have ≤ 8 decimals, so only divisions ever round).
 * - `round(dp)` / `floor(dp)` quantize to the stored/sent scale ({@link USD_DP}, `szDecimals`),
 *   so a balance gets exactly what the ledger records.
 * Numbers enter via their shortest decimal form (`0.1` is "0.1"); values leave as strings
 * for `numeric`, or `toNumber` only at the JSON boundary.
 */
export class Dec {
  static readonly ZERO = new Dec(0n);
  static readonly ONE = new Dec(FACTOR);

  private constructor(private readonly units: Units) {}

  /** @throws when `value` is not a finite decimal. */
  static from(value: DecInput): Dec {
    const parsed = Dec.parse(value);
    if (parsed === null) throw new TypeError(`Not a decimal: ${JSON.stringify(typeof value === "bigint" ? value.toString() : value)}`);
    return parsed;
  }

  /** `value` as a decimal, or null when it is not one (NaN, Infinity, "", "abc", null). */
  static parse(value: unknown): Dec | null {
    if (value instanceof Dec) return value;
    if (typeof value === "bigint") return new Dec(value * FACTOR);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      if (Number.isInteger(value) && Number.isSafeInteger(value)) return new Dec(BigInt(value) * FACTOR);
      const text = String(value);
      return Dec.parse(/e/i.test(text) ? expandExponent(text) : text);
    }
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (isDecimal(text)) return new Dec(toUnits(text));
    // "+1.5", ".5", "5.", "1e-7": forms Hyperliquid does not send but JSON may.
    const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
    const plain = `${m[1] === "-" ? "-" : ""}${m[2] || "0"}${m[3] ? `.${m[3]}` : ""}`;
    return Dec.parse(m[4] ? expandExponent(`${plain}e${m[4]}`) : plain);
  }

  static max(a: Dec, ...rest: Dec[]): Dec { return rest.reduce((m, v) => (v.units > m.units ? v : m), a); }
  static min(a: Dec, ...rest: Dec[]): Dec { return rest.reduce((m, v) => (v.units < m.units ? v : m), a); }
  static sum(values: Iterable<Dec>): Dec { let total = 0n; for (const v of values) total += v.units; return new Dec(total); }

  add(other: DecInput): Dec { return new Dec(this.units + Dec.from(other).units); }
  sub(other: DecInput): Dec { return new Dec(this.units - Dec.from(other).units); }
  mul(other: DecInput): Dec { return new Dec(divRound(this.units * Dec.from(other).units, FACTOR)); }
  /** @throws RangeError on division by zero. */
  div(other: DecInput): Dec { return new Dec(divRound(this.units * FACTOR, Dec.from(other).units)); }
  neg(): Dec { return new Dec(-this.units); }
  abs(): Dec { return this.units < 0n ? new Dec(-this.units) : this; }

  cmp(other: DecInput): -1 | 0 | 1 { const o = Dec.from(other).units; return this.units < o ? -1 : this.units > o ? 1 : 0; }
  eq(other: DecInput): boolean { return this.units === Dec.from(other).units; }
  gt(other: DecInput): boolean { return this.units > Dec.from(other).units; }
  gte(other: DecInput): boolean { return this.units >= Dec.from(other).units; }
  lt(other: DecInput): boolean { return this.units < Dec.from(other).units; }
  lte(other: DecInput): boolean { return this.units <= Dec.from(other).units; }
  get isZero(): boolean { return this.units === 0n; }
  get isPositive(): boolean { return this.units > 0n; }
  get isNegative(): boolean { return this.units < 0n; }
  get sign(): 1 | -1 | 0 { return this.units > 0n ? 1 : this.units < 0n ? -1 : 0; }

  /** Rounded to `dp` decimals, half away from zero. */
  round(dp: number): Dec {
    if (dp >= SCALE) return this;
    const step = pow10(SCALE - dp);
    return new Dec(divRound(this.units, step) * step);
  }

  /** Truncated toward zero to `dp` decimals (an order size never rounds up). */
  floor(dp: number): Dec {
    if (dp >= SCALE) return this;
    const step = pow10(SCALE - dp);
    return new Dec((this.units / step) * step);
  }

  /** Rounded to `figures` significant figures, half away from zero. */
  toSignificant(figures: number): Dec {
    if (this.units === 0n) return this;
    const digits = (this.units < 0n ? -this.units : this.units).toString().length;
    if (digits <= figures) return this;
    const step = pow10(digits - figures);
    return new Dec(divRound(this.units, step) * step);
  }

  get isInteger(): boolean { return this.units % FACTOR === 0n; }

  /** Plain decimal, no exponent, trailing zeros trimmed: "12.5", "0", "-0.00000001". */
  toString(): string { return fromUnits(this.units); }
  /** Exactly `dp` decimals after rounding: "12.50". */
  toFixed(dp: number): string {
    const text = this.round(dp).toString();
    if (dp === 0) return text;
    const [whole, fraction = ""] = text.split(".");
    return `${whole}.${fraction.padEnd(dp, "0")}`;
  }
  /** For JSON and display only: never feed the result back into money arithmetic. */
  toNumber(): number { return Number(this.toString()); }
  toJSON(): string { return this.toString(); }
}

/** "1.5e-7" → "0.00000015", "2e21" → "2000000000000000000000". */
function expandExponent(text: string): string {
  const m = /^(-?)(\d+)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
  if (!m) return text;
  const digits = m[2]! + (m[3] ?? "");
  const point = m[2]!.length + Number(m[4]);
  if (point <= 0) return `${m[1]}0.${"0".repeat(-point)}${digits}`;
  if (point >= digits.length) return `${m[1]}${digits}${"0".repeat(point - digits.length)}`;
  return `${m[1]}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** Shorthand: `d("0.05")`, `d(4.5)`. */
export const d = (value: DecInput): Dec => Dec.from(value);

/** Decimals a USDC amount is quantized to before it is stored or added to a
 * balance (fees, PnL, funding, margin). */
export const USD_DP = 8;
/** Decimals of an averaged entry price (Hyperliquid prices have at most 6). */
export const PX_DP = 10;
