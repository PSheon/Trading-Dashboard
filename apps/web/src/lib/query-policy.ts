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
/** Short recovery window for trader snapshots awaiting upstream capacity. */
export const busyRetry = { retry: retryWithBudget(12), retryDelay };
/** Cold fill-history computation can take approximately ten minutes. */
export const ANALYTICS_BUSY_RETRIES = 120;
export const computingRetry = { retry: retryWithBudget(ANALYTICS_BUSY_RETRIES), retryDelay };
