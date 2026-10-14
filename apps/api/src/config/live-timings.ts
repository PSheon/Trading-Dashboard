import { integerValue } from "./parse-env.js";
import { AGENT_EXPIRY_STOP_MARGIN_MS, SETUP_ANSWER_MS, SETUP_CONFIRM_LEASE_WAIT_MS, SETUP_LEASE_MS, SETUP_POST_MS, SETUP_RESERVE_WAIT_MS, SETUP_RETRY_BACKOFF_BASE_MS, SETUP_RETRY_BACKOFF_MAX_MS,
  SETUP_RETRY_NEEDS_OWNER_MS, SETUP_RETRY_PENDING_MS, SETUP_RETRY_SIGNER_UNAVAILABLE_MS, SETUP_RETRY_TRANSIENT_ATTEMPTS, SETUP_SIGN_MS, STOP_CANCEL_ATTEMPTS, STOP_CLOSE_ATTEMPTS, STOP_SYSTEM_CHECK_MS } from "./constants/timings.js";
import type { RetryPolicy } from "../copy/live/error-class.js";

type Environment = Record<string, string | undefined>;

/**
 * The time a live setup driver may spend (architecture review 2026-10-12
 * §6.3): one lease, the budget of one step inside it, and how a step that
 * did not finish is retried. Today's values are the defaults; every one was
 * a scattered literal before (copy-live-setup.service.ts, copy.module.ts).
 */
export interface LiveSetupTimings {
  /** How long one driver holds a setup (a crashed driver's lease lapses). */
  readonly leaseMs: number;
  /** One step's budget inside the lease, in the order it is spent. Their sum
   * stays below `leaseMs` (asserted at startup): transition() does not fence
   * on the lease token, so a step must end before another driver can lease. */
  readonly stepBudgetMs: {
    /** Longest a step's client (account mode, agent approval, absence proof)
     * waits in line for its Hyperliquid weight (queued, see LiveReserveOptions.queue). */
    readonly reserveWaitMs: number;
    /** The Privy signature after the weight (the builder step's own deadline). */
    readonly signMs: number;
    /** The exchange POST after the signature. */
    readonly postMs: number;
  };
  /** Long setup work answers with its durable row before the HTTP deadline. */
  readonly answerMs: number;
  /** How long a confirmation waits for the worker to let go of its setup. */
  readonly confirmLeaseWaitMs: number;
  readonly retry: {
    /** A step waiting on something it already started (a lookup, a credit, an approval). */
    readonly pendingMs: number;
    /** No worker signer for the setup's account yet. */
    readonly signerUnavailableMs: number;
    /** A failure that may pass: base × 2^attempts, at most maxMs. */
    readonly backoffBaseMs: number;
    readonly backoffMaxMs: number;
    /** A transient failure ends the setup (failed) at this many attempts in
     * one stage (handoff 2026-10-11 §4e: "暫時錯誤可重試 3 次"). Budget waits
     * and outcomes still unknown never count (error-class.ts). */
    readonly transientAttempts: number;
    /** A step waiting for its owner (needs_owner) is looked at again after this. */
    readonly needsOwnerMs: number;
  };
}

/** The time a live stop's worker spends on its own checks and retries. */
export interface LiveStopTimings {
  /** How often expiring agents, liquidations and unfinished close-alls are looked for. */
  readonly systemCheckMs: number;
  /** A copy is stopped this long before its agent expires (one day: room for
   * the stop's closes, retries and return while the agent still signs). */
  readonly agentExpiryMarginMs: number;
  readonly retry: {
    /** A single-position close gives up after this many orders (a stop never does: it backs off). */
    readonly closeAttempts: number;
    /** A tracked resting order's cancel gives up after this many attempts. */
    readonly cancelAttempts: number;
  };
}

export const DEFAULT_LIVE_SETUP_TIMINGS: LiveSetupTimings = Object.freeze({
  leaseMs: SETUP_LEASE_MS,
  stepBudgetMs: Object.freeze({ reserveWaitMs: SETUP_RESERVE_WAIT_MS, signMs: SETUP_SIGN_MS, postMs: SETUP_POST_MS }),
  answerMs: SETUP_ANSWER_MS,
  confirmLeaseWaitMs: SETUP_CONFIRM_LEASE_WAIT_MS,
  retry: Object.freeze({ pendingMs: SETUP_RETRY_PENDING_MS, signerUnavailableMs: SETUP_RETRY_SIGNER_UNAVAILABLE_MS, backoffBaseMs: SETUP_RETRY_BACKOFF_BASE_MS,
    backoffMaxMs: SETUP_RETRY_BACKOFF_MAX_MS, transientAttempts: SETUP_RETRY_TRANSIENT_ATTEMPTS, needsOwnerMs: SETUP_RETRY_NEEDS_OWNER_MS }),
});

export const DEFAULT_LIVE_STOP_TIMINGS: LiveStopTimings = Object.freeze({
  systemCheckMs: STOP_SYSTEM_CHECK_MS,
  agentExpiryMarginMs: AGENT_EXPIRY_STOP_MARGIN_MS,
  retry: Object.freeze({ closeAttempts: STOP_CLOSE_ATTEMPTS, cancelAttempts: STOP_CANCEL_ATTEMPTS }),
});

/** A setup step's retry policy (decideRetry): its transient back-off, the
 * attempts at which a stage gives up, and when an owner's step is looked at
 * again. One table with the copy legs' and the stops' (LIVE_LEG_RETRY_POLICY). */
export const setupRetryPolicy = (timings: LiveSetupTimings): RetryPolicy =>
  ({ baseMs: timings.retry.backoffBaseMs, maxMs: timings.retry.backoffMaxMs, attempts: timings.retry.transientAttempts, needsOwnerMs: timings.retry.needsOwnerMs, waitDefaultMs: timings.retry.pendingMs });

/** Sum of one setup step's budgets: what a driver may spend under one lease. */
export const setupStepBudgetMs = (timings: LiveSetupTimings): number =>
  timings.stepBudgetMs.reserveWaitMs + timings.stepBudgetMs.signMs + timings.stepBudgetMs.postMs;

/** Refuses timings whose step does not fit its lease (a driver would still
 * be writing after another one leased the setup). */
export function assertSetupTimings(timings: LiveSetupTimings): LiveSetupTimings {
  const spent = setupStepBudgetMs(timings);
  if (spent >= timings.leaseMs) {
    throw new Error(`A live setup step's budget (reserve wait ${timings.stepBudgetMs.reserveWaitMs} + sign ${timings.stepBudgetMs.signMs} + POST ${timings.stepBudgetMs.postMs} = ${spent} ms) must be below its lease (COPY_LIVE_SETUP_LEASE_MS ${timings.leaseMs} ms)`);
  }
  if (timings.retry.backoffBaseMs > timings.retry.backoffMaxMs) throw new Error("COPY_LIVE_SETUP_BACKOFF_BASE_MS must not exceed COPY_LIVE_SETUP_BACKOFF_MAX_MS");
  return timings;
}

/** The setup timings from the environment (each optional; today's values by default). */
export function liveSetupTimings(source: Environment): LiveSetupTimings {
  const d = DEFAULT_LIVE_SETUP_TIMINGS;
  return assertSetupTimings({
    leaseMs: integerValue("COPY_LIVE_SETUP_LEASE_MS", source.COPY_LIVE_SETUP_LEASE_MS, d.leaseMs, 10_000, 600_000),
    stepBudgetMs: {
      reserveWaitMs: integerValue("COPY_LIVE_SETUP_RESERVE_WAIT_MS", source.COPY_LIVE_SETUP_RESERVE_WAIT_MS, d.stepBudgetMs.reserveWaitMs, 1_000, 300_000),
      signMs: integerValue("COPY_LIVE_SETUP_SIGN_MS", source.COPY_LIVE_SETUP_SIGN_MS, d.stepBudgetMs.signMs, 1_000, 300_000),
      postMs: integerValue("COPY_LIVE_SETUP_POST_MS", source.COPY_LIVE_SETUP_POST_MS, d.stepBudgetMs.postMs, 1_000, 300_000),
    },
    answerMs: d.answerMs,
    confirmLeaseWaitMs: d.confirmLeaseWaitMs,
    retry: {
      ...d.retry,
      backoffBaseMs: integerValue("COPY_LIVE_SETUP_BACKOFF_BASE_MS", source.COPY_LIVE_SETUP_BACKOFF_BASE_MS, d.retry.backoffBaseMs, 100, 600_000),
      backoffMaxMs: integerValue("COPY_LIVE_SETUP_BACKOFF_MAX_MS", source.COPY_LIVE_SETUP_BACKOFF_MAX_MS, d.retry.backoffMaxMs, 100, 3_600_000),
      transientAttempts: integerValue("COPY_LIVE_SETUP_TRANSIENT_ATTEMPTS", source.COPY_LIVE_SETUP_TRANSIENT_ATTEMPTS, d.retry.transientAttempts, 1, 100),
    },
  });
}

/** The stop timings from the environment (each optional; today's values by default). */
export function liveStopTimings(source: Environment): LiveStopTimings {
  const d = DEFAULT_LIVE_STOP_TIMINGS;
  return {
    systemCheckMs: integerValue("COPY_LIVE_STOP_SYSTEM_CHECK_MS", source.COPY_LIVE_STOP_SYSTEM_CHECK_MS, d.systemCheckMs, 1_000, 3_600_000),
    agentExpiryMarginMs: d.agentExpiryMarginMs,
    retry: { ...d.retry },
  };
}
