/**
 * Exact arithmetic on Hyperliquid's decimal strings ("24513.75250433",
 * "5366091643.4300003052") and Postgres `numeric` values, as bigints scaled
 * by 10^18. Revenue is summed and diffed across thousands of snapshots, so
 * floats would drift; the final value is converted to a number only for the
 * JSON response.
 */

const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

export type Units = bigint;

export function isDecimal(value: unknown): value is string {
  return typeof value === "string" && DECIMAL_RE.test(value);
}

/** Parses a plain decimal string; digits past 18 decimals are truncated. */
export function toUnits(value: string): Units {
  if (!isDecimal(value)) throw new Error(`Not a decimal: ${JSON.stringify(value)}`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  const units = BigInt(whole) * FACTOR + BigInt(fraction.slice(0, SCALE).padEnd(SCALE, "0"));
  return negative ? -units : units;
}

/** Plain decimal string with trailing zeros trimmed ("12.5", "0"). */
export function fromUnits(units: Units): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / FACTOR;
  const fraction = (abs % FACTOR).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export function unitsToNumber(units: Units): number {
  return Number(fromUnits(units));
}

export function maxUnits(a: Units, b: Units): Units {
  return a > b ? a : b;
}
