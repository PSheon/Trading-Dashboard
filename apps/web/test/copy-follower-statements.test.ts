import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CopyExecutionAccount, CopyFollowerStatement } from '@trading-dashboard/shared/contracts';
import { formatFollowerAmount, loadCopyFollowerStatement, parseCopyFollowerStatement, type FollowerStatementOwner } from '@/lib/copy-follower-statements';
import { api, setAccessTokenGetter } from '@/lib/api';

const account: CopyExecutionAccount = { id: 'account', strategyId: 9, network: 'testnet', state: 'ready',
  address: `0x${'22'.repeat(20)}`, issue: null, createdAt: '2026-10-03T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' };
const statement: CopyFollowerStatement = { accountId: account.id, strategyId: 9, network: 'testnet', accountAddress: account.address!, token: 'USDC', receiptCount: '2',
  actual: { realizedPnl: '12.5', exchangeFee: '0.000001', builderFee: '-0.25', funding: '-1', tradingCashDelta: '11.250001' },
  quarantine: { blocked: false, reason: null }, coverage: { historicalCompleteness: 'unproven', scannedThrough: null,
    unresolvedWindows: null, issue: null, updatedAt: null }, latestReceipts: [
    { key: 'fill', kind: 'fill', coin: 'BTC', time: '2026-10-03T00:00:00Z', attribution: 'execution', executionKey: 'execution' },
    { key: 'funding', kind: 'funding', coin: 'BTC', time: '2026-10-03T00:00:01Z', attribution: 'account', executionKey: null }] };
let owner: FollowerStatementOwner, current: CopyExecutionAccount | null;
beforeEach(() => { owner = { status: 'signedIn', mode: 'privy', identity: 'owner', session: '1', walletAddress: null }; current = account; });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); setAccessTokenGetter(null); });
function dependencies() { return { snapshot: () => ({ ...owner }), currentAccount: () => current, read: vi.fn().mockResolvedValue(statement) }; }
type MalformedStatement = Omit<CopyFollowerStatement, "actual" | "coverage" | "quarantine" | "latestReceipts"> & { actual: Partial<Record<keyof CopyFollowerStatement["actual"], unknown>>; coverage: Record<string, unknown>; quarantine: Record<string, unknown>; latestReceipts: Record<string, unknown>[] };
function changed(change: (value: MalformedStatement) => void) { const value = structuredClone(statement); change(value); return value; }

it('loads only the captured owned account and does not require a signing wallet', async () => {
  const deps = dependencies(); expect(await loadCopyFollowerStatement(account, deps)).toEqual(statement);
  expect(deps.read).toHaveBeenCalledExactlyOnceWith('/me/copy/execution-wallets/account/statement', undefined);
});
it('encodes the account id and carries the cancellation signal', async () => {
  const selected = { ...account, id: 'a/b?c' }; current = selected; const deps = dependencies();
  deps.read.mockResolvedValue({ ...statement, accountId: selected.id }); const controller = new AbortController();
  await loadCopyFollowerStatement(selected, { ...deps, signal: controller.signal });
  expect(deps.read).toHaveBeenCalledExactlyOnceWith('/me/copy/execution-wallets/a%2Fb%3Fc/statement', controller.signal);
});
it.each(['identity', 'session', 'walletAddress', 'status', 'mode'] as const)('rejects %s changes while the response is pending', async (field) => {
  const deps = dependencies(); deps.read.mockImplementation(async () => { owner = { ...owner, [field]: 'changed' }; return statement; });
  await expect(loadCopyFollowerStatement(account, deps)).rejects.toThrow('follower_statement_session_changed');
});
it('rejects account selection changes or removal while the response is pending', async () => {
  for (const next of [null, { ...account, id: 'other' }, { ...account, strategyId: 10 }, { ...account, address: `0x${'33'.repeat(20)}` }, { ...account, network: 'mainnet' as const }]) {
    current = account; const deps = dependencies(); deps.read.mockImplementation(async () => { current = next; return statement; });
    await expect(loadCopyFollowerStatement(account, deps)).rejects.toThrow('follower_statement_account_changed');
  }
});
it.each([{ status: 'signedOut' }, { mode: 'fixture' }, { identity: null }])('does not request private data for %j', async (change) => {
  owner = { ...owner, ...change }; const deps = dependencies(); await expect(loadCopyFollowerStatement(account, deps)).rejects.toThrow(); expect(deps.read).not.toHaveBeenCalled();
});
it('refuses an aborted read even if a boundary supplies a late result', async () => {
  const controller = new AbortController(), deps = dependencies(); deps.read.mockImplementation(async () => { controller.abort(); return statement; });
  await expect(loadCopyFollowerStatement(account, { ...deps, signal: controller.signal })).rejects.toThrow();
});
it.each([
  ['wrong account', (v: MalformedStatement) => { v.accountId = 'other'; }],
  ['wrong strategy', (v: MalformedStatement) => { v.strategyId++; }],
  ['wrong network', (v: MalformedStatement) => { v.network = 'mainnet'; }],
  ['wrong address', (v: MalformedStatement) => { v.accountAddress = `0x${'33'.repeat(20)}`; }],
  ['unknown PnL', (v: MalformedStatement) => { delete v.actual.realizedPnl; }],
  ['null fees', (v: MalformedStatement) => { v.actual.exchangeFee = null; }],
  ['nonfinite amount', (v: MalformedStatement) => { v.actual.funding = 'Infinity'; }],
  ['inconsistent cash delta', (v: MalformedStatement) => { v.actual.tradingCashDelta = '0'; }],
  ['missing coverage', (v: MalformedStatement) => { Reflect.deleteProperty(v, "coverage"); }],
  ['invented complete history', (v: MalformedStatement) => { v.coverage.historicalCompleteness = 'complete'; }],
  ['duplicate receipts', (v: MalformedStatement) => { v.latestReceipts[1].key = v.latestReceipts[0].key; }],
  ['missing execution attribution', (v: MalformedStatement) => { v.latestReceipts[0].executionKey = null; }],
  ['unknown quarantine', (v: MalformedStatement) => { v.quarantine.blocked = null; }],
  ['impossible receipt count', (v: MalformedStatement) => { v.receiptCount = '0'; }],
] as const)('rejects malformed statement instead of fabricating totals: %s', (_name, change) => expect(() => parseCopyFollowerStatement(changed(change), account)).toThrow());
it('preserves null scan data and signed components instead of filling unknowns with zero', () => {
  const result = parseCopyFollowerStatement(statement, account);
  expect(result.coverage.unresolvedWindows).toBeNull(); expect(result.coverage.scannedThrough).toBeNull();
  expect(result.actual.exchangeFee).toBe('0.000001'); expect(result.actual.funding).toBe('-1');
});
it.each([
  ['12.5000', '+12.5 USDC'], ['-0.000001', '-0.000001 USDC'], ['0', '0 USDC'], ['-0.000', '0 USDC'],
  ['9007199254740993.00000001', '+9,007,199,254,740,993.00000001 USDC'], ['00012.50', '+12.5 USDC'],
] as const)('formats exact signed receipt amount %s without floating point loss', (value, want) => expect(formatFollowerAmount(value)).toBe(want));

it('uses the real private GET wire contract without caching or putting the token in a URL', async () => {
  vi.stubEnv('NEXT_PUBLIC_API_FIXTURES', '0'); setAccessTokenGetter(async () => 'test-private-token', 'owner');
  const path = '/me/copy/execution-wallets/account/statement';
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ success: true, statusCode: 200, message: 'OK', data: statement, meta: { timestamp: '2026-10-03T00:00:00.000Z', requestId: 'id', path } }));
  vi.stubGlobal('fetch', fetcher);
  const result = await loadCopyFollowerStatement(account, { ...dependencies(), read: (url, signal) => api.get(url, signal) });
  expect(result.actual.exchangeFee).toBe('0.000001');
  expect(fetcher.mock.calls[0][0]).toBe(`/api/hl${path}`);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', cache: 'no-store', headers: { Authorization: 'Bearer test-private-token' } });
});
it('captures an immutable account identity before awaiting a response', async () => {
  const selected = { ...account }; current = selected; const deps = dependencies();
  deps.read.mockImplementation(async () => { selected.strategyId = 10; return { ...statement, strategyId: 10 }; });
  await expect(loadCopyFollowerStatement(selected, deps)).rejects.toThrow('follower_statement_account_changed');
});
