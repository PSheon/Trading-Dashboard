// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLiveCopyPortfolioActions } from '@/lib/copy-live-portfolio';

/** Duplication audit bug 7: the portfolio actions' idempotency keys belong to
 * the signed-in owner and session (as copy-live-stop's journal). A retry by
 * the same owner reuses its key; another account or a new sign-in never does. */
const state = vi.hoisted(() => ({ post: vi.fn(), auth: { status: 'signedIn', mode: 'privy', identity: 'owner-a@email' }, session: '1' }));
vi.mock('@/lib/auth', () => ({ useAuth: () => state.auth }));
vi.mock('@/lib/api', async () => ({ ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')), api: { get: vi.fn(), post: state.post }, sessionKey: () => state.session }));

let actions: ReturnType<typeof useLiveCopyPortfolioActions> | null = null;
function Probe() {
  const current = useLiveCopyPortfolioActions();
  useLayoutEffect(() => { actions = current; });
  return null;
}
let root: Root, container: HTMLDivElement, client: QueryClient;
beforeEach(() => {
  vi.clearAllMocks(); state.auth = { status: 'signedIn', mode: 'privy', identity: 'owner-a@email' }; state.session = '1';
  container = document.createElement('div'); document.body.append(container); root = createRoot(container); client = new QueryClient();
  // The request fails: the key is kept for a retry.
  state.post.mockRejectedValue(new Error('network'));
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
const render = () => act(async () => root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>));
async function returnKey(): Promise<string> {
  await act(async () => { await actions!.transfer.mutateAsync({ accountId: 'account-1', amount: '5' }).catch(() => undefined); });
  return (state.post.mock.calls.at(-1)![1] as { idempotencyKey: string }).idempotencyKey;
}
async function closeKey(): Promise<string> {
  await act(async () => { await actions!.close.mutateAsync({ accountId: 'account-1', coin: 'BTC' }).catch(() => undefined); });
  return (state.post.mock.calls.at(-1)![1] as { idempotencyKey: string }).idempotencyKey;
}

it("a retry by the same owner reuses its key; another account signed in on the page gets its own", async () => {
  await render();
  const first = await returnKey(), firstClose = await closeKey();
  expect(await returnKey()).toBe(first);
  expect(await closeKey()).toBe(firstClose);
  state.auth = { status: 'signedIn', mode: 'privy', identity: 'owner-b@email' };
  await render();
  const other = await returnKey();
  expect(other).not.toBe(first);
  expect(await closeKey()).not.toBe(firstClose);
});

it('a new sign-in session of the same owner gets a new key', async () => {
  await render();
  const first = await returnKey();
  state.session = '2';
  await render();
  expect(await returnKey()).not.toBe(first);
});
