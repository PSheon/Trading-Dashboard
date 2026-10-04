import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ReferralService } from '../src/referral/referral.service.js';
import type { ReferralRepository } from '../src/referral/referral.repository.js';

function fixture() {
  const repository = {
    overview: vi.fn().mockResolvedValue({ code: 'EXAMPLE', referred: false, bindOpenUntil: '2026-10-04T00:30:00.000Z', policy: { version: 'disabled-v1', enabled: false, rewardBps: null, minClaimUnits: null }, balances: { earned: '0', available: '0', pending: '0', claimed: '0' }, hasWallet: false }),
    check: vi.fn().mockResolvedValue(true), setCode: vi.fn().mockResolvedValue({ code: 'NEWCODE' }),
    bind: vi.fn().mockResolvedValue({ bound: true }), friends: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    claims: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), claim: vi.fn(), findClaim: vi.fn(),
  };
  return { repository, service: new ReferralService(repository as unknown as ReferralRepository) };
}
describe('referral service boundaries', () => {
  it('reports unavailable economic capability and unknown rates honestly', async () => {
    const { service } = fixture(); const result = await service.me(7);
    expect(result).toMatchObject({ canClaim: false, claimCapability: { enabled: false, reason: 'collection_and_payout_unavailable' }, policy: { rewardBps: null, minClaimUnits: null } });
    expect(result.link).toBe('/r/EXAMPLE');
  });
  it('normalizes legitimate codes but rejects reserved and malformed inputs before DAL', async () => {
    const { service, repository } = fixture();
    await service.setCode(7, ' newcode '); expect(repository.setCode).toHaveBeenCalledWith(7, 'NEWCODE');
    for (const code of ['ADMIN', 'a', '../ROOT', 'A'.repeat(17)]) await expect(service.setCode(7, code)).rejects.toThrow();
    expect(repository.setCode).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid owner IDs, cursors and claim keys even outside HTTP validation', async () => {
    const { service, repository } = fixture();
    for (const owner of [0, -1, 1.5, Number.NaN]) await expect(service.me(owner)).rejects.toThrow();
    await expect(service.claim(7, 'bad-key')).rejects.toThrow();
    await expect(service.claims(7, { cursor: 'not-a-cursor' })).rejects.toThrow();
    expect(repository.claim).not.toHaveBeenCalled();
  });
  it('passes the exact owner and original key to the durable claim path', async () => {
    const { service, repository } = fixture();
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    repository.claim.mockResolvedValue({ id: 'existing-operation' });
    expect(await service.claim(7, key)).toEqual({ id: 'existing-operation' });
    expect(repository.claim).toHaveBeenCalledWith(7, key);
  });
});
