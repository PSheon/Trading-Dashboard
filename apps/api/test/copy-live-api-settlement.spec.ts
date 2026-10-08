import { describe, expect, it, vi } from 'vitest';
import { CopyLiveEngine, type LiveEngineDependencies } from '../src/copy/live-worker/copy-live-engine.js';

const row = { id: 'd', mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', sourceFillId: 'f', leg: 'open',
  state: 'submitted', executionKey: 'testnet:account:cloid', attempts: 1, reason: null } as const;
const mandate = { mandateId: 'm', userId: 1, strategyId: 9, accountId: 'a', accountAddress: `0x${'11'.repeat(20)}`,
  sourceNetwork: 'testnet', leaderAddress: `0x${'22'.repeat(20)}` } as const;
function fixture(network: 'testnet' | 'mainnet', state: string) {
  const settle = vi.fn(async () => ({ kind: 'released' as const })), execute = vi.fn(async () => ({ key: row.executionKey, state: 'filled' })), update = vi.fn();
  const deps = { network, apiTerminalSettlement: true, repository: { journalState: async () => state, update }, runtime: () => ({ execute }), settler: { settle } } as unknown as LiveEngineDependencies;
  return { engine: new CopyLiveEngine(deps, { testnetSourceIntervalMs: 60000, sourceLagMs: 1000, passBudgetMs: 20000 }), settle, execute, update };
}
describe('API terminal settlement handoff', () => {
  it.each(['filled', 'partial', 'cancelled', 'rejected'])('worker leaves testnet submitted %s durable without paid settlement', async state => {
    const f = fixture('testnet', state);
    await f.engine.work(row as never, mandate as never, 120000);
    expect(f.settle).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
  });
  it('mainnet retains the existing settlement branch', async () => {
    const f = fixture('mainnet', 'filled');
    await f.engine.work(row as never, mandate as never, 120000);
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.update).toHaveBeenCalledWith(row, expect.objectContaining({ state: 'settled' }));
  });
  it('testnet uncertain submission still reconciles in worker', async () => {
    const f = fixture('testnet', 'unknown');
    await f.engine.work(row as never, mandate as never, 120000);
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.settle).not.toHaveBeenCalled();
  });
});
