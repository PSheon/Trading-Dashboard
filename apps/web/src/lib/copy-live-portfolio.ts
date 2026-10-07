'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { copyFundingSchema, copyReturnChallengeSchema, liveCopyPortfolioSchema, liveManualCloseSchema, type LiveCopyPortfolioItem } from '@trading-dashboard/shared/contracts';
import { api, sessionKey } from './api';
import { useAuth } from './auth';
import { isTransient } from './copy-error-text';
import { liveCopyEnabled } from './copy-live-setup';
import { busyRetry } from './query-policy';
import { queryKeys } from './query-keys';

const ROOT = '/me/copy/live';
export type LiveCopyItem = LiveCopyPortfolioItem;

/** A copy made on another network than this deployment's (Stage's testnet
 * copies after its move to mainnet): history only. Never counted in 我的資金,
 * never listed under 跟單中, never acted on (Stage A1, 2026-10-07). */
export function onOtherNetwork(item: Pick<LiveCopyItem, 'network'>, deploymentNetwork: string | null | undefined): boolean {
  return Boolean(deploymentNetwork && item.network && item.network !== deploymentNetwork);
}

function usePortfolioKey() {
  const auth = useAuth();
  return [...queryKeys.copy.all, 'live-portfolio', auth.status, auth.mode, auth.identity, sessionKey()] as const;
}

/** The owner's testnet copies with their stage (setup, deposit, funding,
 * awaiting credit, starting, active, paused, stopping, sweeping, stopped). */
export function useLiveCopyPortfolio() {
  const auth = useAuth();
  const enabled = liveCopyEnabled(auth);
  const query = useQuery({ queryKey: usePortfolioKey(), enabled, staleTime: 0, ...busyRetry, refetchInterval: 10_000, refetchOnWindowFocus: true,
    queryFn: async ({ signal }) => liveCopyPortfolioSchema.parse(await api.get(`${ROOT}/portfolio`, signal)) });
  // A failed first read is reported (the portfolio shows it with a retry),
  // not turned into "no testnet copies". A passing failure of a later read
  // keeps the last answer: the rows and any dialog open on them stay.
  return { ...query, enabled, data: enabled && (!query.isError || isTransient(query.error)) ? query.data : undefined };
}

/**
 * The owner's actions on a testnet copy. Each keeps one idempotency key per
 * attempt (a retry reuses it: the server returns the original operation and
 * never sends twice). Nothing here signs: the worker signs every copy-account
 * action under the owner's policy.
 */
export function useLiveCopyPortfolioActions() {
  const client = useQueryClient(), key = usePortfolioKey(), auth = useAuth();
  // Keys belong to the signed-in owner and session (as copy-live-stop's
  // journal): another account, or a new sign-in, never reuses one.
  const owner = JSON.stringify([auth.status, auth.mode, auth.identity, sessionKey()]);
  const keys = useRef(new Map<string, string>());
  const scoped = (name: string) => `${owner}\n${name}`;
  const keyFor = (name: string) => { let value = keys.current.get(scoped(name)); if (!value) { value = crypto.randomUUID(); keys.current.set(scoped(name), value); } return value; };
  const done = (name: string) => { keys.current.delete(scoped(name)); void client.invalidateQueries({ queryKey: key, exact: true }); void client.invalidateQueries({ queryKey: [...queryKeys.copy.all] }); };

  /** Idle funds while copying (an amount), or everything after a flat stop
   * ("all"): the worker signs it (its policy allows only the main wallet).
   * A copy without the worker signer is refused (409 worker_signer_missing). */
  const transfer = useMutation({
    mutationFn: async ({ accountId, amount }: { accountId: string; amount: string }) => {
      const name = `return:${accountId}:${amount}`;
      const challenge = copyReturnChallengeSchema.parse(await api.post(`${ROOT}/execution-wallets/${encodeURIComponent(accountId)}/returns`, { idempotencyKey: keyFor(name), amount }));
      if (challenge.operation.status !== 'prepared') { done(name); return challenge.operation; }
      const result = copyFundingSchema.parse(await api.post(`${ROOT}/returns/${encodeURIComponent(challenge.operation.id)}/approve`, {}));
      done(name); return result;
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
  return { transfer, close, cancelTransfer };
}
