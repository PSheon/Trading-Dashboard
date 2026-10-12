import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { isoUtcSchema, liveCopySetupAbortSchema, networkSchema } from '@trading-dashboard/shared/contracts';

/** E3 #1: each schema a primitive replaced must accept and refuse exactly what
 * its hand-written copy did. The "old" side is the copy as it stood. */
const fields = liveCopySetupAbortSchema.innerType().shape;
const cases: [string, z.ZodTypeAny, z.ZodTypeAny, z.ZodTypeAny, unknown[]][] = [
  ['network', z.enum(['testnet', 'mainnet']), networkSchema, fields.network,
    ['testnet', 'mainnet', 'Mainnet', 'TESTNET', 'devnet', '', ' mainnet', 'mainnet ', null, undefined, 0, 1, true, {}, ['mainnet']]],
  ['iso instant', z.string().datetime(), isoUtcSchema, fields.createdAt,
    ['2026-10-12T00:00:00Z', '2026-10-12T00:00:00.123Z', '2026-10-12T00:00:00.123456789Z', '2026-10-12T00:00:00+00:00', '2026-10-12T08:00:00+08:00',
      '2026-10-12T00:00:00', '2026-10-12', '2026-10-12 00:00:00Z', '2026-13-01T00:00:00Z', 'not a date', '', null, undefined, 1_760_000_000_000, new Date(0)]],
];
describe.each(cases)('%s', (_name, old, primitive, migrated, inputs) => {
  it.each(inputs.map((input) => [input]))('agrees on %j', (input) => {
    const expected = old.safeParse(input);
    for (const schema of [primitive, migrated]) {
      const actual = schema.safeParse(input);
      expect(actual.success).toBe(expected.success);
      if (actual.success && expected.success) expect(actual.data).toEqual(expected.data);
    }
  });
});
it('keeps the setup abort timestamps on the same primitive', () => {
  expect(fields.updatedAt.safeParse('2026-10-12T08:00:00+08:00').success).toBe(false);
  expect(fields.updatedAt.safeParse('2026-10-12T00:00:00Z').success).toBe(true);
});
