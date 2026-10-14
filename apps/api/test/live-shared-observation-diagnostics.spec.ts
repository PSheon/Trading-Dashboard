import { describe, expect, it } from 'vitest';
import { LiveSharedReads, observationComparison } from '../src/copy/live/live-shared-reads.js';

const clock = () => 1_800_000_000_000;
async function comparison(type: string, before: unknown, after: unknown, leaders: string[] = []) {
  let calls = 0;
  const shared = new LiveSharedReads('testnet', async () => Response.json(calls++ ? after : before), undefined, clock);
  const bodies = [{ type, user: 'private-wallet' }];
  await shared.wave(bodies);
  return shared.unchanged(bodies, 'live_account_observation_changed', observationComparison(leaders));
}

describe('shared observation refusal diagnostics without provider payloads', () => {
  it("goes on the dex names alone: a per-dex market parameter moves on its own (mainnet probe 2026-10-14)", async () => {
    const dexes = (rate: string, cap: string) => [null, { name: 'mkts', assetToFundingInterestRate: [['mkts:BVIV', rate]], assetToStreamingOiCap: [['mkts:BVIV', cap]] }];
    await expect(comparison('perpDexs', dexes('0.0001', '1'), dexes('0.0002', '2'))).resolves.toBeUndefined();
  });
  it('identifies a renamed, added or reordered dex as a changed dex response', async () => {
    const list = (...names: string[]) => [null, ...names.map(name => ({ name }))];
    const changes: [string[], string[]][] = [[['xyz'], ['xyz2']], [['xyz'], ['xyz', 'abc']], [['xyz', 'abc'], ['xyz']], [['xyz', 'abc'], ['abc', 'xyz']]];
    for (const [before, after] of changes) {
      await expect(comparison('perpDexs', list(...before), list(...after))).rejects.toMatchObject({
        code: 'live_account_observation_changed', changedReads: ['perpDexs'],
      });
    }
  });
  it('identifies changed spot balances while keeping values and account addresses out of the error', async () => {
    const error = await comparison('spotClearinghouseState', { balances: [{ total: 'sensitive-before' }] },
      { balances: [{ total: 'sensitive-after' }] }).catch(error => error);
    expect(error).toMatchObject({ code: 'live_account_observation_changed', changedReads: ['spotClearinghouseState'] });
    expect(JSON.stringify(error)).not.toMatch(/sensitive|private-wallet|balances/);
    expect(error.message).toBe('live_account_observation_changed');
    expect(Object.isFrozen(error.changedReads)).toBe(true);
  });
  it('does not copy an unreviewed request type into a diagnostic', async () => {
    const error = await comparison('secret-provider-request', 1, 2).catch(error => error);
    expect(error).toMatchObject({ changedReads: ['unclassified'] });
    expect(JSON.stringify(error)).not.toContain('secret-provider-request');
  });
  it('continues to accept genuinely unchanged responses', async () => {
    await expect(comparison('userAbstraction', 'disabled', 'disabled')).resolves.toBeUndefined();
  });
  it("goes on only the leader's portfolio-margin flag: its balances move with its own trades (Stage mainnet 2026-10-12)", async () => {
    const spot = (total: string, portfolioMarginEnabled?: boolean) => ({ balances: [{ coin: 'USDC', total }], ...(portfolioMarginEnabled === undefined ? {} : { portfolioMarginEnabled }) });
    await expect(comparison('spotClearinghouseState', spot('1'), spot('2'), ['private-wallet'])).resolves.toBeUndefined();
    await expect(comparison('spotClearinghouseState', spot('1'), spot('2', true), ['private-wallet'])).rejects.toMatchObject({ changedReads: ['spotClearinghouseState'] });
    // An observed account's own spot state must still not change.
    await expect(comparison('spotClearinghouseState', spot('1'), spot('2'), ['another-leader'])).rejects.toMatchObject({ changedReads: ['spotClearinghouseState'] });
  });
});
