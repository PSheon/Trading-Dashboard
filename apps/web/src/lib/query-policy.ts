import { isBusy } from "@/lib/api";

/** Stop permanent failures and cancellation before applying endpoint retry budgets. */
function retryWithBudget(busyBudget: number) {
  return (count: number, error: Error) => {
    const status = (error as { status?: number }).status;
    if (error.name === "AbortError" || (status !== undefined && status >= 400 && status < 500)) return false;
    return count < (isBusy(error) ? busyBudget : 1);
  };
}

function retryDelay(attempt: number, error: Error) {
  return isBusy(error)
    ? Math.min(30_000, error.retryAfterMs ?? 5_000)
    : Math.min(1000 * 2 ** attempt, 30_000);
}

export const defaultRetry = { retry: retryWithBudget(1), retryDelay };
/** Short recovery window for wallet snapshots awaiting upstream capacity. */
export const busyRetry = { retry: retryWithBudget(12), retryDelay };

const permanent = (error: Error) => {
  const status = (error as { status?: number }).status;
  return error.name === "AbortError" || (status !== undefined && status >= 400 && status < 500);
};

/**
 * CopyDog's trader-page backoff: a 503 waits 5 s, 10 s, 15 s (capped at
 * 20 s) and never less than the api's Retry-After (itself capped at 30 s);
 * any other failure 1 s, 2 s, 4 s (capped at 8 s).
 */
export function traderRetryDelay(attempt: number, error: Error): number {
  if ((error as { status?: number }).status !== 503) return Math.min(1000 * 2 ** attempt, 8_000);
  const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs ?? 0;
  return Math.min(30_000, Math.max(retryAfterMs, Math.min(5_000 * (attempt + 1), 20_000)));
}

/** Silent retries of a trader-page request before its failure shows, as on CopyDog. */
export const TRADER_RETRIES = 3;
export const traderRetry = {
  retry: (count: number, error: Error) => !permanent(error) && count < TRADER_RETRIES,
  retryDelay: traderRetryDelay,
};
/** Cold fill-history computation can take approximately ten minutes: a busy
 * answer keeps being asked for that long (at the backoff's 20 s), while the
 * page stops showing placeholders after `TRADER_RETRIES`. */
export const ANALYTICS_BUSY_RETRIES = 30;
export const computingRetry = {
  retry: (count: number, error: Error) => !permanent(error) && count < (isBusy(error) ? ANALYTICS_BUSY_RETRIES : TRADER_RETRIES),
  retryDelay: traderRetryDelay,
};
