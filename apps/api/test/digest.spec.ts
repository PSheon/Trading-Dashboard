import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { jsonDigest, sha256Hex } from '../src/common/crypto/digest.js';
import { attemptDigest } from '../src/copy/copy-funding-exchange.client.js';
import type { FundingRow } from '../src/copy/copy-funding.repository.js';

/** E3 #2: the helpers are the inline `createHash('sha256').update(JSON.stringify(v)).digest('hex')`, byte for byte. */
const inline = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const values: unknown[] = [null, 0, -0, 1.5, 1e21, '', 'é 中  ', true, [], {}, [1, 'a', null], { b: 1, a: [2, { c: '3' }] }, { a: undefined, b: () => 1 },
  { status: 'ok', response: { type: 'default' } }, new Date(Date.UTC(2026, 9, 12)), { big: '123456789012345678901234567890' }];
it('jsonDigest is sha256 hex of JSON.stringify', () => {
  for (const value of values) expect(jsonDigest(value)).toBe(inline(value));
  expect(jsonDigest({ a: 1, b: 2 })).not.toBe(jsonDigest({ b: 2, a: 1 }));
  expect(() => jsonDigest(undefined)).toThrow(TypeError);
  expect(() => inline(undefined)).toThrow(TypeError);
});
it('sha256Hex hashes strings and bytes as createHash does', () => {
  for (const data of ['', 'abc', 'é 中', Buffer.from([0, 255, 1]), Buffer.alloc(0)])
    expect(sha256Hex(data)).toBe(createHash('sha256').update(data).digest('hex'));
  expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
it('the funding attempt digest (process-local, never stored) is unchanged', () => {
  const at = new Date(Date.UTC(2026, 9, 12, 1, 2, 3, 4));
  const row: FundingRow = { id: 'test', userId: 1, accountId: 'account', strategyId: 1, idempotencyKey: 'test-key', network: 'testnet', address: `0x${'11'.repeat(20)}`,
    destination: `0x${'22'.repeat(20)}`, amount: '12.5', nonce: 1780000000000, status: 'unknown', direction: 'to_account', stopId: null, claimedAt: at, attemptedAt: at,
    evidenceHash: null, transactionHash: null, creditedAmount: null, fee: null, scanState: null, scanRevision: 0, liveSetupId: null, setupAbortId: null, createdAt: at, updatedAt: at };
  const old = (r: FundingRow) => createHash('sha256').update(JSON.stringify(
    Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))),
  )).digest('hex');
  for (const r of [row, { ...row, nonce: row.nonce + 1 }, { ...row, attemptedAt: null }, { ...row, status: 'accepted' as const, evidenceHash: 'ab' }])
    expect(attemptDigest(r)).toBe(old(r));
});
