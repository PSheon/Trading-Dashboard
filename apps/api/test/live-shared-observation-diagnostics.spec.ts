import { describe, expect, it } from 'vitest';
import { LiveSharedReads } from '../src/copy/live/live-shared-reads.js';

const clock = () => 1_800_000_000_000;
async function comparison(type: string, before: unknown, after: unknown) {
  let calls = 0;
  const shared = new LiveSharedReads('testnet', async () => Response.json(calls++ ? after : before), undefined, clock);
  const bodies = [{ type, user: 'private-wallet' }];
  await shared.wave(bodies);
  return shared.unchanged(bodies, 'live_account_observation_changed');
}

describe('shared observation refusal diagnostics without provider payloads', () => {
  it('identifies a changed dex response and still refuses ancillary-field changes', async () => {
    await expect(comparison('perpDexs', [null, { name: 'xyz', assetToStreamingOiCap: [['ETH', '1']] }],
      [null, { name: 'xyz', assetToStreamingOiCap: [['ETH', '2']] }])).rejects.toMatchObject({
      code: 'live_account_observation_changed', changedReads: ['perpDexs'],
    });
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
});
