import { describe, expect, it, vi } from 'vitest';
import type { CopyExecutionAccount, LiveCopyMandate } from '@trading-dashboard/shared/contracts';
import { canResumeLiveCopyStop, createLiveStopJournal, requestLiveCopyStop, type LiveStopAttempt } from '@/lib/copy-live-stop';

// A mainnet deployment's copy (Stage since 2026-10-07): its stop was refused
// in the browser as "not testnet", so the owner could not stop a real-money copy.
const at = '2026-10-07T01:00:00.000Z', address = `0x${'ab'.repeat(20)}`;
const account: CopyExecutionAccount = { id: 'account-1', strategyId: 7, network: 'mainnet', state: 'ready', address, createdAt: at, updatedAt: at, issue: null };
const mandate: LiveCopyMandate = { id: 'mandate-1', accountId: account.id, strategyId: 7, mode: 'actual', network: 'mainnet', accountAddress: address,
  sourceNetwork: 'mainnet', leaderAddress: `0x${'cd'.repeat(20)}`, budgetUsd: '50', strategyVersion: 1, state: 'active', revision: 3,
  activationCursor: at, expiresAt: '2026-10-08T01:00:00.000Z', createdAt: at, updatedAt: at };
const owner = { status: 'signedIn', mode: 'privy', identity: 'owner@example.com', session: '1', ownerId: 'did:privy:owner' };
function memory() { const values = new Map<string, string>(); return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } }; }

describe('a mainnet copy in the browser', () => {
  it('requests its stop (the stop was refused as stop_binding)', async () => {
    const journal = createLiveStopJournal('privy:did:privy:owner', memory());
    const post = vi.fn(async (_id: string, body: LiveStopAttempt['request'], beforeSend: () => void) => {
      beforeSend();
      return { id: '7f9e2a52-3c55-4c39-9a9b-3f4f0c0f7a11', accountId: account.id, mandateId: mandate.id, strategyId: 7, network: 'mainnet', accountAddress: address,
        originalMandateRevision: body.expectedMandateRevision, revision: 1, state: 'requested', desiredAction: 'cancel_and_close', trackedExecutionCount: 0,
        trackingComplete: true, issue: null, flatVerifiedAt: null, createdAt: at, updatedAt: at };
    });
    const result = await requestLiveCopyStop({ account, mandate }, { snapshot: () => owner, current: () => ({ account, mandate }), journal,
      newKey: () => 'mainnet-stop-key-0000000001', post, find: vi.fn() });
    expect(post).toHaveBeenCalledOnce();
    expect(post.mock.calls[0]![0]).toBe(mandate.id);
    expect(result).toMatchObject({ network: 'mainnet', mandateId: mandate.id });
    expect(journal.read()).toMatchObject([{ network: 'mainnet', dispatchState: 'possible_sent' }]);
  });
  it('can resume an unsent mainnet stop, and never one whose account is on the other network', () => {
    const attempt: LiveStopAttempt = { request: { idempotencyKey: 'mainnet-stop-key-0000000001', expectedMandateRevision: 3 }, accountId: account.id, mandateId: mandate.id,
      strategyId: 7, network: 'mainnet', accountAddress: address, ownerId: owner.ownerId, dispatchState: 'unsent' };
    expect(canResumeLiveCopyStop(attempt, { account, mandate }, owner.ownerId)).toBe(true);
    expect(canResumeLiveCopyStop(attempt, { account: { ...account, network: 'testnet' }, mandate }, owner.ownerId)).toBe(false);
  });
});
