import { HttpException } from '@nestjs/common';
import { LiveBoundaryError } from '../copy/live/wallet-authorization.js';
import { HyperliquidBudgetWait } from '../hyperliquid/hyperliquid-budget-wait.js';

/** Whether the error itself carries a code: a LiveBoundaryError, a
 * HyperliquidBudgetWait, or a message that is a code. */
const coded = (error: unknown): boolean =>
  error instanceof LiveBoundaryError || error instanceof HyperliquidBudgetWait || error instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(error.message);
/**
 * THE boundary error an error wraps: the first LiveBoundaryError or
 * HyperliquidBudgetWait found walking `cause` (and an AggregateError's
 * errors) to depth 4, else null. A wrapper (the wallet library around our
 * signer's `signTypedData`, viem, fetch, an AbortSignal) is not what failed:
 * gate 12 (2026-10-17) logged a `live_risk_stale` thrown inside signing as
 * an unexpected `AbstractWalletError` and retried it as such. The error's
 * own code, when it has one, always wins (`errorCode`, error-class.ts).
 */
export const boundaryErrorOf = (error: unknown, depth = 0): LiveBoundaryError | HyperliquidBudgetWait | null => {
  if (!error || typeof error !== 'object' || depth > 4) return null;
  if (error instanceof LiveBoundaryError || error instanceof HyperliquidBudgetWait) return error;
  if (error instanceof AggregateError) for (const inner of error.errors) { const found = boundaryErrorOf(inner, depth + 1); if (found) return found; }
  return boundaryErrorOf(Object.getOwnPropertyDescriptor(error, 'cause')?.value, depth + 1);
};
/** An error that is no boundary code and wraps none (a TypeError, a
 * timeout): its name and where it came from, for the log only. Never its
 * message, which may echo provider data or key material (security review
 * 2026-10-06): the stack frames are code locations only. */
export const describeUnexpected = (error: unknown): string | null => {
  if (coded(error) || boundaryErrorOf(error)) return null;
  if (!(error instanceof Error)) return `non-error ${typeof error}`;
  const frames = (error.stack ?? '').split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at '))
    .map(line => line.replace(/^at\s+/, '').replace(/\(?(?:file:\/\/)?[^()]*\/(apps|node_modules|node:internal)\//, '($1/')).slice(0, 4);
  return `${/^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'Error'}${frames.length ? ` @ ${frames.join(' | ').slice(0, 400)}` : ''}`;
};
/** An error's boundary code (a LiveBoundaryError's, `live_budget_wait` for a
 * HyperliquidBudgetWait, or a message that is one), else the code of the
 * boundary error it wraps (boundaryErrorOf), else `fallback`. */
export const errorCode = (error: unknown, fallback = 'live_execution_failed'): string => {
  const own = coded(error) ? error : boundaryErrorOf(error) ?? error;
  const code = own instanceof LiveBoundaryError ? own.code : own instanceof HyperliquidBudgetWait ? 'live_budget_wait' : own instanceof Error && /^[a-z][a-z0-9_]{0,79}$/.test(own.message) ? own.message : fallback;
  return code.replace(/[^a-z0-9_]/g, '_').slice(0, 80);
};
/** What a log may say about any error: its boundary code, or its name and
 * code locations (describeUnexpected), with a provider's HTTP status when it
 * has one. Never a raw message. */
export const safeErrorText = (error: unknown): string => {
  const status = (error as { status?: unknown } | null)?.status;
  return `${typeof status === 'number' && Number.isInteger(status) ? `${status} ` : ''}${describeUnexpected(error) ?? errorCode(error)}`;
};
/** One structured log payload for a failure a loop keeps going past: its
 * code (an HttpException's response code, else errorCode), safeErrorText,
 * and a Hyperliquid wait's reason, retry and detail (bucket, weight…). */
export const errorLogFields = (error: unknown): Record<string, unknown> => {
  const response = error instanceof HttpException ? error.getResponse() : null;
  const http = response && typeof response === 'object' ? (response as { code?: unknown }).code : undefined;
  return { code: typeof http === 'string' && /^[a-z][a-z0-9_]{2,79}$/.test(http) ? http : errorCode(error, 'unexpected'), error: safeErrorText(error),
    ...(error instanceof HyperliquidBudgetWait ? { wait: { reason: error.reason, retryMs: Math.ceil(error.retryMs), ...error.detail } } : {}) };
};
