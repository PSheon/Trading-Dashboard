import { Dec } from '../../common/decimal/dec.js';

export type LiveRiskDecimalFactor = Dec | string | number;
function rational(value: LiveRiskDecimalFactor): { units: bigint; scale: bigint } {
  if (!(value instanceof Dec) && typeof value !== 'string' && typeof value !== 'number') throw new RangeError('live_risk_rounding_invalid');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('live_risk_rounding_invalid');
  const text = value instanceof Dec ? value.toString() : String(value);
  if (text.length > 80 || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(text)) throw new RangeError('live_risk_rounding_invalid');
  const [whole, fraction = ''] = text.split('.');
  return { units: BigInt(whole! + fraction), scale: 10n ** BigInt(fraction.length) };
}

/** Exact nonnegative product/quotient ceiling. No intermediate Dec.mul/div
 * rounding may erase a liability before the requested storage precision. */
export function ceilDecimalProduct(factors: readonly LiveRiskDecimalFactor[], divisors: readonly LiveRiskDecimalFactor[] = [], dp = 18): Dec {
  if (!Number.isSafeInteger(dp) || dp < 0 || dp > 18 || factors.length < 1 || factors.length > 16 || divisors.length > 16)
    throw new RangeError('live_risk_rounding_invalid');
  let numerator = 10n ** BigInt(dp), denominator = 1n;
  for (const factor of factors) { const r = rational(factor); numerator *= r.units; denominator *= r.scale; }
  for (const divisor of divisors) {
    const r = rational(divisor); if (r.units === 0n) throw new RangeError('live_risk_rounding_invalid');
    numerator *= r.scale; denominator *= r.units;
  }
  const units = numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
  if (dp === 0) return Dec.from(units.toString());
  const digits = units.toString().padStart(dp + 1, '0');
  return Dec.from(`${digits.slice(0, -dp)}.${digits.slice(-dp)}`);
}
