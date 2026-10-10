import { expect, it, vi } from 'vitest';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';
import type { DispatchRow, LiveMandateWork } from '../src/copy/live-worker/copy-live-worker.repository.js';
import { LiveBoundaryError } from '../src/copy/live/wallet-authorization.js';
import { LiveReadComparisonError } from '../src/copy/live/live-shared-reads.js';

it('retains each coded refusal in logs when a retry replaces the stored reason, without logging error payloads', async () => {
  let clock = 1_000;
  const log: string[] = [];
  const row = { id: 'original-leg', state: 'pending', leg: 'open', attempts: 0, adjustmentId: null,
    userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: 'source', leaderTime: new Date(1_000),
    firstAttemptAt: null } as unknown as DispatchRow;
  const mandate = { accountAddress: `0x${'11'.repeat(20)}` } as LiveMandateWork;
  const errors = [new LiveBoundaryError('live_risk_stale'), new LiveBoundaryError('live_account_observation_unavailable')];
  Object.assign(errors[0]!, { providerBody: { authorization: 'private-provider-token' } });
  const update = vi.fn(async (_row: DispatchRow, patch: Partial<DispatchRow>) => Object.assign(row, patch));
  const engine = new CopyLiveEngine({ network: 'testnet', log: (line: string) => log.push(line),
    repository: { journalState: async () => null, signalAgeLimitMs: async () => 120_000, update },
    runtime: () => ({ execute: async () => { const error = errors.shift(); clock += 5_500; throw error; } }),
  } as unknown as LiveEngineDependencies, undefined, () => clock);
  const execute = (engine as unknown as { execute(row: DispatchRow, mandate: LiveMandateWork): Promise<void> }).execute.bind(engine);
  await execute(row, mandate);
  await execute(row, mandate);
  expect(row.reason).toBe('live_account_observation_unavailable');
  expect(row.attempts).toBe(2);
  expect(log.some(line => line.includes('live_risk_stale'))).toBe(true);
  expect(log.some(line => line.includes('live_account_observation_unavailable'))).toBe(true);
  expect(log.filter(line => line.includes('attempt 1') && line.includes('5500 ms'))).toHaveLength(1);
  expect(log.filter(line => line.includes('attempt 2') && line.includes('5500 ms'))).toHaveLength(1);
  expect(log.join('\n')).not.toContain('private-provider-token');
  expect(log.join('\n')).not.toContain('providerBody');
});

it('logs reviewed changed-read categories for an observation refusal without granting a retry bypass', async () => {
  const log: string[] = [];
  const row = { id: 'original-leg', state: 'pending', leg: 'open', attempts: 0, adjustmentId: null,
    userId: 1, accountId: 'account', mandateId: 'mandate', sourceFillId: 'source', leaderTime: new Date(1_000),
    firstAttemptAt: null } as unknown as DispatchRow;
  const engine = new CopyLiveEngine({ network: 'testnet', log: (line: string) => log.push(line),
    repository: { journalState: async () => null, signalAgeLimitMs: async () => 120_000,
      update: async (_row: DispatchRow, patch: Partial<DispatchRow>) => Object.assign(row, patch) },
    runtime: () => ({ execute: async () => { throw new LiveReadComparisonError('live_account_observation_changed', ['perpDexs', 'private-request']); } }),
  } as unknown as LiveEngineDependencies, undefined, () => 1_000);
  await (engine as unknown as { execute(row: DispatchRow, mandate: LiveMandateWork): Promise<void> }).execute(row,
    { accountAddress: `0x${'11'.repeat(20)}` } as LiveMandateWork);
  expect(row.reason).toBe('live_account_observation_changed');
  expect(row.attempts).toBe(1);
  expect(log.join('\n')).toContain('changed reads perpDexs,unclassified');
  expect(log.join('\n')).not.toContain('private-request');
});
