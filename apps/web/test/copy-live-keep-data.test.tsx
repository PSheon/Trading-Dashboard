// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLiveCopyPortfolio } from '@/lib/copy-live-portfolio';
import { useLiveCopyOverview } from '@/lib/copy-live';

/** Web audit H3: one failed poll must not unmount every testnet-copy dialog.
 * A passing failure of a refetch keeps the last answer; a refusal for good
 * (4xx) drops it. */
const state = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', identity: 'owner@email', wallet: { address: `0x${'11'.repeat(20)}` } }) }));
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: { get: state.get, post: vi.fn() }, sessionKey: () => '1' }));

const portfolio = { network: 'testnet', automaticExecution: true, items: [] };
const overview = { mode: 'actual', network: 'testnet', capabilities: { strategyPreparation: true, automaticExecution: true, sourceNetworks: ['mainnet'] }, strategies: [], mandates: [] };
const seen: { portfolio: ReturnType<typeof useLiveCopyPortfolio> | null; overview: ReturnType<typeof useLiveCopyOverview> | null } = { portfolio: null, overview: null };
function Probe() {
  const p = useLiveCopyPortfolio(), o = useLiveCopyOverview();
  useLayoutEffect(() => { seen.portfolio = p; seen.overview = o; });
  return null;
}
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => { vi.clearAllMocks(); container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient(); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });

it('a 503 or the network on a refetch keeps the portfolio and the overview; a 404 drops them', async () => {
  const { ApiError } = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    state.get.mockImplementation(async (path: string) => path.endsWith('/portfolio') ? portfolio : overview);
    await act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(seen.portfolio!.data).toEqual(portfolio);
    expect(seen.overview!.data).toMatchObject({ mode: 'actual' });
    state.get.mockRejectedValue(new ApiError(502, 'Bad Gateway', { code: 'bad_gateway' }));
    // (the portfolio retries a passing failure once first)
    await act(async () => { void seen.portfolio!.refetch(); void seen.overview!.refetch(); await vi.advanceTimersByTimeAsync(5_000); });
    expect(seen.portfolio!.isError).toBe(true);
    expect(seen.portfolio!.data).toEqual(portfolio);
    expect(seen.overview!.data).toMatchObject({ mode: 'actual' });
    state.get.mockRejectedValue(new ApiError(404, 'Not Found'));
    await act(async () => { void seen.portfolio!.refetch(); void seen.overview!.refetch(); await vi.advanceTimersByTimeAsync(5_000); });
    expect(seen.portfolio!.data).toBeUndefined();
    expect(seen.overview!.data).toBeUndefined();
  } finally { vi.useRealTimers(); }
});

it("whether testnet copy is available is read once a minute, not on the site-wide 10 s poll (web audit L5)", async () => {
  const { useLiveCopyAvailable } = await import('@/lib/copy-live-setup');
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    state.get.mockImplementation(async () => overview);
    const polling = new QueryClient({ defaultOptions: { queries: { refetchInterval: 10_000 } } });
    function Available() { useLiveCopyAvailable(); return null; }
    await act(async () => root.render(<QueryClientProvider client={polling}><Available /></QueryClientProvider>));
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(state.get).toHaveBeenCalledTimes(1);
    polling.clear();
  } finally { vi.useRealTimers(); }
});
