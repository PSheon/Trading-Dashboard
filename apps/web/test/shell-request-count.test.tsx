// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { CopyEquityProbes, useCopiesEquity } from '@/lib/copy-equity';
import { useCopyOverview } from '@/lib/copy';
import { useLiveCopyDeployment } from '@/lib/copy-live-setup';
import { useIdentityRefetch } from '@/lib/use-identity-refetch';
import { createSessionQueryClient } from '@/lib/session-query-client';
import { useWallet } from '@/lib/wallet';

/**
 * Stage, explore page, 2026-10-23: one page view fired /me/copy/live/portfolio
 * ×6, /me/copy ×6, /me/copy/execution-wallets ×5 and /me/wallet ×3 within
 * ~20 s. The shell below is the explore page's: the account pill's reads
 * (useCopyOverview, useWallet, the copies' equity), the trading mode's
 * deployment read, and — once the deployment is known — CopyEquityProbes,
 * which reads the portfolio and the execution wallets again. A visitor with
 * a saved session arrives as "loading" and turns out signed in 500 ms later;
 * a public board was read meanwhile. Every /me endpoint is read once at
 * sign-in, and then only on its own poll: one request per endpoint per
 * page view while the session is stable.
 */
const LATENCY = 120;
const state = vi.hoisted(() => ({
  auth: { status: 'loading', mode: 'privy', identity: null as string | null, wallet: null } as { status: string; mode: string; identity: string | null; wallet: null },
  calls: new Map<string, number[]>(),
  now: 0,
}));
vi.mock('@/lib/auth', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  sessionKey: () => '1',
  // The board was read anonymously while the visitor was unknown.
  takeAnonymousReads: () => true,
  api: {
    get: vi.fn(async (path: string) => {
      state.calls.set(path, [...(state.calls.get(path) ?? []), Date.now() - state.now]);
      await new Promise((resolve) => setTimeout(resolve, LATENCY));
      return answers[path] ?? {};
    }),
    post: vi.fn(),
  },
}));
const answers: Record<string, unknown> = {
  '/me/copy/live': { mode: 'actual', network: 'testnet', capabilities: { strategyPreparation: true, automaticExecution: true, sourceNetworks: ['mainnet'] }, strategies: [], mandates: [] },
  '/me/copy/live/portfolio': { network: 'testnet', automaticExecution: true, items: [] },
  '/me/copy': { paper: { totalValue: 0 }, strategies: [] },
  '/me/copy/execution-wallets': { accounts: [], authorizations: [] },
  '/me/wallet': { network: 'testnet' },
  '/discover/board': { items: [] },
};
const counts = () => Object.fromEntries([...state.calls].map(([path, at]) => [path, at.length]).sort());

/** The parts of the shell that read /me (AccountMenu's hooks) plus a public read. */
function AccountPill() {
  useCopyOverview(); useWallet(); useCopiesEquity();
  return null;
}
function Board() {
  useQuery({ queryKey: ['discover-board'], queryFn: ({ signal }) => import('@/lib/api').then(({ api }) => api.get('/discover/board', signal)) });
  return null;
}
/** The trading mode becomes available once the deployment is read; the probes mount then (account-controls.tsx). */
function Probes() {
  const deployment = useLiveCopyDeployment();
  return deployment?.available ? <CopyEquityProbes /> : null;
}
/** As AuthEffects before the page: the identity refetch first, then what reads.
 * The pill is mounted all along (its reads disabled while loading) or, as
 * AuthButton mounts it, only once signed in; the phone header mounts a second
 * pill (AuthButton compact), so it is rendered twice. */
function Shell({ status, pillWhileLoading }: { status: string; pillWhileLoading: boolean }) {
  useIdentityRefetch(status as 'loading' | 'signedIn');
  const pill = pillWhileLoading || status === 'signedIn';
  return <><Board />{pill ? <><AccountPill /><Probes /><AccountPill /><Probes /></> : null}</>;
}
function App({ pillWhileLoading }: { pillWhileLoading: boolean }) {
  const [, setTick] = useState(0);
  useEffect(() => { rerender = () => setTick((n) => n + 1); }, []);
  return <QueryClientProvider client={client}><Shell status={state.auth.status} pillWhileLoading={pillWhileLoading} /></QueryClientProvider>;
}
let rerender = () => {};
let root: Root, container: HTMLDivElement, client: ReturnType<typeof createSessionQueryClient>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ shouldAdvanceTime: true });
  state.calls.clear(); state.now = Date.now();
  state.auth = { status: 'loading', mode: 'privy', identity: null, wallet: null };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = createSessionQueryClient();
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); vi.useRealTimers(); });

it.each([{ pillWhileLoading: false }, { pillWhileLoading: true }])('reads each /me endpoint once at sign-in and then once per poll, however many shell parts read it (pill mounted while loading: $pillWhileLoading)', async ({ pillWhileLoading }) => {
  await act(async () => root.render(<App pillWhileLoading={pillWhileLoading} />));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(counts()).toEqual({ '/discover/board': 1 });

  state.auth = { status: 'signedIn', mode: 'privy', identity: 'owner@email', wallet: null };
  await act(async () => { rerender(); });
  // Settled: the deployment answered, the probes mounted and read what they need.
  await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
  // The board is read again, signed in (its own fields); nothing under /me twice.
  expect(counts()).toEqual({ '/discover/board': 2, '/me/copy/live': 1, '/me/copy': 1, '/me/wallet': 1, '/me/copy/live/portfolio': 1, '/me/copy/execution-wallets': 1 });

  // Twenty seconds in: two 10 s polls each (one for the wallet's 20 s), from
  // one timer per endpoint — not one per component that reads it.
  await act(async () => { await vi.advanceTimersByTimeAsync(15_500); });
  expect(counts()).toEqual({ '/discover/board': 2, '/me/copy/live': 1, '/me/copy': 3, '/me/wallet': 2, '/me/copy/live/portfolio': 3, '/me/copy/execution-wallets': 3 });
});
