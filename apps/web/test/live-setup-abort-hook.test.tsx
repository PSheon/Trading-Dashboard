// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LiveCopySetup } from '@trading-dashboard/shared/contracts';
import { useLiveSetupAbort } from '@/lib/copy-live-setup-abort';
import { liveSettings } from './copy-live-fixtures';
const state = vi.hoisted(() => ({ capability: false, userId: 'did:privy:owner', session: '1', siteMode: 'testnet', get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ status: 'signedIn', mode: 'privy', userId: state.userId, identity: state.userId, wallet: null }) }));
vi.mock('@/lib/copy-live-setup', () => ({ useLiveCopyDeployment: () => ({ network: 'testnet', available: true, setupAbort: state.capability }) }));
vi.mock('@/lib/site-mode', () => ({ useSiteMode: () => state.siteMode }));
vi.mock('@/lib/api', () => ({ api: { get: state.get, post: state.post }, sessionKey: () => state.session }));
const date = '2026-10-09T00:00:00.000Z';
const base: LiveCopySetup = { id: '11111111-1111-4111-8111-111111111111', kind: 'start', strategyId: 1, accountId: 'account', leaderAddress: `0x${'44'.repeat(20)}`, sourceNetwork: 'testnet', budgetUsd: '50', settings: liveSettings, stage: 'funded', issue: null, consent: null, funding: null, mandateId: null, setupDeadline: null, createdAt: date, updatedAt: date };
const progress = () => ({ id: '22222222-2222-4222-8222-222222222222', setupId: base.id, kind: base.kind, strategyId: base.strategyId, accountId: base.accountId, network: 'testnet', state: 'reconciling', issue: null, deposit: null, refund: null, stop: null, createdAt: date, updatedAt: date });
let root: Root, container: HTMLDivElement, client: QueryClient;
const probe = { current: null as ReturnType<typeof useLiveSetupAbort> | null };
function Probe({ setup }: { setup: LiveCopySetup }) { const value = useLiveSetupAbort(setup); useLayoutEffect(() => { probe.current = value; }); return null; }
async function render(setup = base) { await act(async () => root.render(<QueryClientProvider client={client}><Probe setup={setup} /></QueryClientProvider>)); }
async function settle() { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); Object.assign(state, { capability: false, userId: 'did:privy:owner', session: '1', siteMode: 'testnet' }); state.get.mockReset(); state.post.mockReset(); sessionStorage.clear(); probe.current = null; client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
it('an older API without capability or a saved abort is not queried or mutated', async () => { await render(); await settle(); expect(probe.current?.available).toBe(false); expect(state.get).not.toHaveBeenCalled(); expect(state.post).not.toHaveBeenCalled(); });
it('keeps saved progress readable when new abort requests are disabled', async () => { state.get.mockResolvedValue(progress()); await render({ ...base, abortRequested: true }); await settle(); expect(probe.current?.progress?.state).toBe('reconciling'); expect(probe.current?.available).toBe(false); await act(async () => probe.current!.request()); await settle(); expect(state.post).not.toHaveBeenCalled(); expect(probe.current?.error).toMatchObject({ message: 'setup_abort_unavailable' }); });
it('does not expose a late original-owner read to the next signed-in owner', async () => { state.capability = true; let resolve!: (value: unknown) => void; state.get.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue(null); await render(); state.userId = 'did:privy:next'; state.session = '2'; await render(); await act(async () => resolve(progress())); await settle(); expect(probe.current?.progress).toBeNull(); const old = client.getQueryCache().findAll({ queryKey: ['copy', 'setup-abort', 'did:privy:owner'] }); expect(old.every(query => query.state.data === undefined)).toBe(true); expect(state.post).not.toHaveBeenCalled(); });
it('switching to simulation stops reading actual abort progress', async () => { state.capability = true; state.get.mockResolvedValue(progress()); await render(); await settle(); const calls = state.get.mock.calls.length; state.siteMode = 'paper'; await render(); await settle(); expect(probe.current?.available).toBe(false); expect(probe.current?.progress).toBeNull(); expect(state.get).toHaveBeenCalledTimes(calls); expect(state.post).not.toHaveBeenCalled(); });
