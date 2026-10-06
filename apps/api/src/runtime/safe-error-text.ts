import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { HyperliquidBudgetWait } from '../hyperliquid/hyperliquid-budget-wait.js';

/** An error that is no boundary code (a TypeError, a timeout): its name and
 * where it came from, for the log only. Never its message, which may echo
 * provider data or key material (security review 2026-10-06): the stack
 * frames are code locations only. */
export const describeUnexpected = (error: unknown): string | null => {
  if (error instanceof LiveBoundaryError || error instanceof HyperliquidBudgetWait || error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message)) return null;
  if (!(error instanceof Error)) return `non-error ${typeof error}`;
  const frames = (error.stack ?? '').split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at '))
    .map(line => line.replace(/^at\s+/, '').replace(/\(?(?:file:\/\/)?[^()]*\/(apps|node_modules|node:internal)\//, '($1/')).slice(0, 4);
  return `${/^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error'}${frames.length ? ` @ ${frames.join(' | ').slice(0, 400)}` : ''}`;
};
/** An error's boundary code (a LiveBoundaryError's, `live_budget_wait` for a
 * HyperliquidBudgetWait, or a message that is one), else `fallback`. */
export const errorCode = (error: unknown, fallback = 'live_execution_failed'): string => {
  const code = error instanceof LiveBoundaryError ? error.code : error instanceof HyperliquidBudgetWait ? 'live_budget_wait' : error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message) ? error.message : fallback;
  return code.replace(/[^a-z0-9_]/g, '_').slice(0, 80);
};
/** What a log may say about any error: its boundary code, or its name and
 * code locations (describeUnexpected), with a provider's HTTP status when it
 * has one. Never a raw message. */
export const safeErrorText = (error: unknown): string => {
  const status = (error as { status?: unknown } | null)?.status;
  return `${typeof status === 'number' && Number.isInteger(status) ? `${status} ` : ''}${describeUnexpected(error) ?? errorCode(error)}`;
};
