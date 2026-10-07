import { beforeEach, expect, it, vi } from 'vitest';
import { loadCopyFollowerSnapshot, parseCopyFollowerSnapshot } from '@/lib/copy-follower-snapshot';
import type { FollowerStatementOwner } from '@/lib/copy-follower-statements';
import { activityAccount as account, otherActivityAccount } from './copy-follower-activity-fixtures';
import { followerSnapshot } from './copy-follower-snapshot-fixtures';
type BrokenView = { mode: unknown; network: unknown; accountAddress: unknown; metrics: Record<string, unknown>; asOf: Record<string, unknown>; coverage: Record<string, unknown>; freshness: unknown; lastReadIssue: unknown; dexes: Record<string, unknown>[] };
let owner: FollowerStatementOwner, current: typeof account | null;
beforeEach(() => { owner = { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1', walletAddress: null }; current = account; });
function deps() { return { snapshot: () => ({ ...owner }), currentAccount: () => current, read: vi.fn().mockResolvedValue(followerSnapshot()) }; }
it('loads an exact testnet master cached view without inventing returns', async () => {
  const d = deps(), result = await loadCopyFollowerSnapshot(account, d); expect(result).toMatchObject({ mode: 'actual', network: 'testnet', status: 'observed', metrics: { perpEquity: '100', roi: null, netDeposits: null, periodPnl: null } }); expect(d.read).toHaveBeenCalledExactlyOnceWith('/me/copy/execution-wallets/account/snapshot', undefined);
});
it.each(['identity', 'session', 'mode', 'status', 'walletAddress'] as const)('refuses a response after %s changes', async key => {
  const d = deps(); d.read.mockImplementation(async () => { owner = { ...owner, [key]: 'changed' }; return followerSnapshot(); }); await expect(loadCopyFollowerSnapshot(account, d)).rejects.toThrow('follower_snapshot_session_changed');
});
it.each([null, otherActivityAccount, { ...account, strategyId: 11 }, { ...account, address: otherActivityAccount.address }])('refuses a response after master selection changes', async next => {
  const d = deps(); d.read.mockImplementation(async () => { current = next; return followerSnapshot(); }); await expect(loadCopyFollowerSnapshot(account, d)).rejects.toThrow('follower_snapshot_account_changed');
});
it('loads a mainnet account (a mainnet deployment) and refuses a view of the other network', async () => {
  const main = { ...account, network: 'mainnet' as const };
  const d = deps(); current = main; d.read.mockResolvedValue({ ...followerSnapshot(), network: 'mainnet' }); await expect(loadCopyFollowerSnapshot(main, d)).resolves.toMatchObject({ network: 'mainnet', status: 'observed' });
  d.read.mockResolvedValue(followerSnapshot()); await expect(loadCopyFollowerSnapshot(main, d)).rejects.toThrow('follower_snapshot_account_changed'); current = account;
});
it('does not call the cached snapshot route for an unknown network or demo accounts', async () => {
  const d = deps(); await expect(loadCopyFollowerSnapshot({ ...account, network: 'devnet' } as unknown as typeof account, d)).rejects.toThrow('follower_snapshot_network_unsupported'); expect(d.read).not.toHaveBeenCalled();
  owner.mode = 'fixture'; await expect(loadCopyFollowerSnapshot(account, d)).rejects.toThrow(); expect(d.read).not.toHaveBeenCalled();
});
it.each([
  ['paper substitution', (v: BrokenView) => { v.mode = 'paper'; }], ['wrong master', (v: BrokenView) => { v.accountAddress = otherActivityAccount.address; }],
  ['invented ROI', (v: BrokenView) => { v.metrics.roi = '0'; }], ['incomplete coverage', (v: BrokenView) => { v.coverage.complete = false; }],
  ['future/invalid proof ordering', (v: BrokenView) => { v.asOf.observedAt = Number(v.asOf.completedAt) + 1; }], ['invented freshness duration', (v: BrokenView) => { v.asOf.freshUntil = Number(v.asOf.observedAt) + 999999; }],
  ['stale proof labelled fresh', (v: BrokenView) => { v.asOf.checkedAt = Number(v.asOf.freshUntil) + 1; }], ['failed acquisition labelled fresh', (v: BrokenView) => { v.lastReadIssue = 'source_unavailable'; }],
  ['mismatched aggregate', (v: BrokenView) => { v.metrics.perpEquity = '101'; }], ['missing venue', (v: BrokenView) => { v.coverage.listedDexes = ['', 'missing']; }],
] as const)('refuses %s instead of false actual data', (_name, edit) => { const v = structuredClone(followerSnapshot()) as unknown as BrokenView; edit(v); expect(() => parseCopyFollowerSnapshot(v, account)).toThrow(); });
it('refuses timestamps outside the representable date range before rendering', () => {
  const v = followerSnapshot(), impossible = 8640000000000001;
  v.asOf = { observedAt: impossible, completedAt: impossible, earliestProviderTime: impossible, checkedAt: impossible, freshUntil: impossible + 5000 }; v.dexes[0].providerTime = impossible;
  expect(() => parseCopyFollowerSnapshot(v, account)).toThrow();
});
it('preserves unavailable and failed-acquisition states without fabricating zero balances', () => {
  const unavailable = { mode: 'actual', network: 'testnet', accountId: account.id, strategyId: account.strategyId, accountAddress: account.address, status: 'unavailable', observation: null, reason: 'not_observed' };
  expect(parseCopyFollowerSnapshot(unavailable, account)).toEqual(unavailable);
  const s = followerSnapshot(); s.freshness = 'stale'; s.lastReadIssue = 'source_unavailable'; expect(parseCopyFollowerSnapshot(s, account)).toMatchObject({ freshness: 'stale', lastReadIssue: 'source_unavailable' });
});
