'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { copyFundingSchema, copyReturnChallengeSchema, copyReturnConsentTypedData, liveCopyPortfolioSchema, liveManualCloseSchema,
  liveStopCancellationChallengeSchema, liveStopCancellationOwnerTypedData, type LiveCopyPortfolioItem } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { queryKeys } from './query-keys';
import type { Eip712TypedData } from './wallet-signer';

const ROOT = '/me/copy/live';
export type LiveCopyItem = LiveCopyPortfolioItem;

function usePortfolioKey() {
  const auth = useAuth();
  return [...queryKeys.copy.all, 'live-portfolio', auth.status, auth.mode, auth.identity, sessionKey()] as const;
}

/** The owner's testnet copies with their stage (setup, deposit, funding,
 * awaiting credit, starting, active, paused, stopping, sweeping, stopped). */
export function useLiveCopyPortfolio() {
  const auth = useAuth();
  const enabled = auth.status === 'signedIn' && auth.mode === 'privy' && Boolean(auth.identity);
  const query = useQuery({ queryKey: usePortfolioKey(), enabled, staleTime: 0, retry: false, refetchInterval: 10_000, refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => liveCopyPortfolioSchema.parse(await api.get(`${ROOT}/portfolio`, signal)) });
  // A failed read is reported (the portfolio shows it with a retry), not
  // turned into "no testnet copies".
  return { ...query, enabled, data: enabled && !query.isError ? query.data : undefined };
}

/**
 * The owner's actions on a testnet copy. Each keeps one idempotency key per
 * attempt (a retry reuses it: the server returns the original operation and
 * never sends twice). Consents are signed by the main wallet.
 */
export function useLiveCopyPortfolioActions() {
  const auth = useAuth(), client = useQueryClient(), key = usePortfolioKey();
  const keys = useRef(new Map<string, string>());
  const keyFor = (name: string) => { let value = keys.current.get(name); if (!value) { value = crypto.randomUUID(); keys.current.set(name, value); } return value; };
  const done = (name: string) => { keys.current.delete(name); void client.invalidateQueries({ queryKey: key, exact: true }); void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); };
  const sign = (typed: Eip712TypedData) => { const wallet = auth.wallet; if (!wallet) throw new Error('owner_wallet_unavailable'); return wallet.signTypedData(typed); };

  /** Idle funds while copying (an amount), or everything after a flat stop ("all"). */
  const transfer = useMutation({
    mutationFn: async ({ accountId, amount }: { accountId: string; amount: string }) => {
      const name = `return:${accountId}:${amount}`;
      const challenge = copyReturnChallengeSchema.parse(await api.post(`${ROOT}/execution-wallets/${encodeURIComponent(accountId)}/returns`, { idempotencyKey: keyFor(name), amount }));
      if (challenge.operation.status !== 'prepared') { done(name); return challenge.operation; }
      const consentSignature = await sign(copyReturnConsentTypedData(challenge.consent));
      const result = copyFundingSchema.parse(await api.post(`${ROOT}/returns/${encodeURIComponent(challenge.operation.id)}/approve`, { consentSignature }));
      done(name); return result;
    },
  });
  /** The owner's consent to cancel a stopping copy's tracked orders. */
  const cancellation = useMutation({
    mutationFn: async ({ stopId }: { stopId: string }) => {
      const challenge = liveStopCancellationChallengeSchema.parse(await api.post(`${ROOT}/stops/${encodeURIComponent(stopId)}/cancellation/challenge`, {}));
      if (challenge.consented) { done(`cancel:${stopId}`); return challenge; }
      const consentSignature = await sign(liveStopCancellationOwnerTypedData(challenge.intent));
      const result = liveStopCancellationChallengeSchema.parse(await api.post(`${ROOT}/stops/${encodeURIComponent(stopId)}/cancellation`, { consentSignature }));
      done(`cancel:${stopId}`); return result;
    },
  });
  /** Close one position of a running copy (the worker sends the orders). */
  const close = useMutation({
    mutationFn: async ({ accountId, coin }: { accountId: string; coin: string }) => {
      const name = `close:${accountId}:${coin}`;
      const result = liveManualCloseSchema.parse(await api.post(`${ROOT}/execution-wallets/${encodeURIComponent(accountId)}/positions/close`, { idempotencyKey: keyFor(name), coin }));
      done(name); return result;
    },
  });
  /** Cancel a return prepared but never sent (its consent lost with a page
   * reload, or no longer wanted): recovered from the portfolio, no key needed. */
  const cancelTransfer = useMutation({
    mutationFn: async ({ operationId }: { operationId: string }) => {
      const result = copyFundingSchema.parse(await api.post(`/me/copy/funding/${encodeURIComponent(operationId)}/cancel`, {}));
      done(`cancel-transfer:${operationId}`); return result;
    },
  });
  return { transfer, cancellation, close, cancelTransfer };
}
