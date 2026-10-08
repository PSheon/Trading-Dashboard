/** Exact display of the validated original fraction; never re-sizes an order. */
export function formatOriginalReductionPercent(value: string): string {
  if (!/^0(?:\.\d{1,18})?$/.test(value)) throw new Error('Invalid original reduction fraction');
  const [, fraction = ''] = value.split('.');
  const units = BigInt(fraction.padEnd(18, '0'));
  const scale = BigInt('10000000000000000');
  const tail = (units % scale).toString().padStart(16, '0').replace(/0+$/, '');
  return `${units / scale}${tail ? `.${tail}` : ''}%`;
}
