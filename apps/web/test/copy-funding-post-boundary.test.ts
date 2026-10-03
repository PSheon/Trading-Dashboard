import { afterEach, expect, it, vi } from 'vitest';
import type { CopyFunding } from '@trading-dashboard/shared/contracts';
import { api, setAccessTokenGetter } from '@/lib/api';
import { runCopyFunding } from '@/lib/copy-funding-operation';
afterEach(() => { vi.unstubAllGlobals(); setAccessTokenGetter(null); });
it('sends zero HTTP when the original funding guard becomes stale during token acquisition', async () => {
  let changed = false, finish!: (token: string) => void, waiting!: () => void;
  const tokenWait = new Promise<void>(resolve => { waiting = resolve; }); setAccessTokenGetter(() => { waiting(); return new Promise(resolve => { finish = resolve; }); }, 'owner');
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal('fetch', fetcher);
  const op: CopyFunding = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', accountId: 'account', strategyId: 9, network: 'testnet', address: `0x${'11'.repeat(20)}`, destination: `0x${'22'.repeat(20)}`, amount: '10', nonce: 1780000000000, status: 'prepared', canCancel: true, transactionHash: null, fee: null, creditedAmount: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
  const dependencies = { assertSession() {}, assertCurrent: () => { if (changed) throw new Error('funding_current_changed'); }, sign: async () => 'signature', claim: async () => ({ claimed: true, operation: { ...op, status: 'unknown' as const } }), submit: (operation: CopyFunding, signature: string, beforeSend?: () => void) => api.post<CopyFunding>(`/me/copy/funding/${operation.id}/submit`, { signature }, { beforeSend }), reconcile: async () => op };
  const pending = runCopyFunding(op, dependencies); await tokenWait; changed = true; const rejected = expect(pending).rejects.toThrow('funding_current_changed'); finish('owner-token'); await rejected; expect(fetcher).not.toHaveBeenCalled();
});
