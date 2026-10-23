import { isIP } from "node:net";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { WALLET_NETWORKS } from "@trading-dashboard/shared/contracts";

import { booleanValue, databaseUrl, integerValue, servicePermissions } from "./parse-env.js";
import { runsCopy, workerRoleValue } from "../runtime/worker-role.js";
import { liveSetupTimings, liveStopTimings, type LiveSetupTimings, type LiveStopTimings } from "./live-timings.js";
import { HYPERLIQUID_BACKGROUND_REST_CAP, MAINNET_WORKER_WEIGHT, READ_WORKER_BACKGROUND_REST_CAP } from './constants/hyperliquid.js';
import { isReadMeterKey, readMeterKey, type HyperliquidMeter } from '../hyperliquid/hyperliquid-meter-key.js';
import { FAST_SOURCE_GRACE_MS, LIVE_EVIDENCE_MAX_AGE_MS, LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS } from './constants/timings.js';
import { DATABASE_POOL_MAX_API, DATABASE_POOL_MAX_COPY_WORKER, DATABASE_POOL_MAX_READ_WORKER, DATABASE_POOL_MAX_WORKER } from './constants/database.js';
import { COPY_EQUITY_FULL_RESOLUTION_MS } from './constants/cache-ttls.js';
import { DAY_MS } from './constants/time.js';



type Environment = Record<string, string | undefined>;
const optional = (value: string | undefined) => value?.trim() || undefined;
function oneOf<T extends string>(key: string, raw: string | undefined, values: readonly T[], fallback: T): T {
  const value = optional(raw)?.toLowerCase() ?? fallback;
  if (!(values as readonly string[]).includes(value)) throw new Error(`${key} must be ${values.join(" or ")}`);
  return value as T;
}

function urlValue(key: string, raw: string | undefined, fallback: string, protocols: string[]): string {
  const value = raw ?? fallback;
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error();
  } catch {
    throw new Error(`${key} must be a valid ${protocols.join("/")} URL without credentials or fragment`);
  }
  return value;
}

/** COPY_LIVE_WEIGHT_PER_MIN's ceiling: a wallet-network bucket holds
 * 1200 − its rate at once, and must hold a setup's account-mode step (715). */
export const MAX_COPY_LIVE_WEIGHT_PER_MIN = 1200 - 715;
/**
 * HYPERLIQUID_NETWORK picks where the user's own wallet lives: the network
 * whose balances /me/wallet reads and whose chain the browser signs bridge
 * and withdraw actions for. Default testnet: mainnet signing needs Paul's
 * explicit approval. Discovery reads use HYPERLIQUID_API_URL (mainnet) either way.
 */
function walletNetwork(source: Environment) {
  const raw = (source.HYPERLIQUID_NETWORK ?? "testnet").trim().toLowerCase();
  if (raw !== "mainnet" && raw !== "testnet") throw new Error("HYPERLIQUID_NETWORK must be mainnet or testnet");
  const defaults = WALLET_NETWORKS[raw];
  return {
    network: raw as "mainnet" | "testnet",
    infoUrl: defaults.infoUrl as string,
    arbitrumRpcUrl: urlValue("HYPERLIQUID_ARBITRUM_RPC_URL", optional(source.HYPERLIQUID_ARBITRUM_RPC_URL), defaults.arbitrumRpcUrl, ["http:", "https:"]),
  };
}

/** The variables only a signing or verifying process reads (PRIVY_VERIFICATION_KEY needs PRIVY_APP_ID). */
const PRIVY_VARIABLES = ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_VERIFICATION_KEY", "PRIVY_AGENT_AUTHORIZATION_KEY", "PRIVY_AGENT_WORKER_QUORUM_ID"] as const;
interface AgentSigningConfig { authorizationPrivateKey: string; authorizationPublicKey: string; workerQuorumId: string }
function agentSigning(source: Environment): AgentSigningConfig | undefined {
  const authorizationPrivateKey = optional(source.PRIVY_AGENT_AUTHORIZATION_KEY);
  const workerQuorumId = optional(source.PRIVY_AGENT_WORKER_QUORUM_ID);
  if (Boolean(authorizationPrivateKey) !== Boolean(workerQuorumId)) throw new Error("PRIVY_AGENT_AUTHORIZATION_KEY and PRIVY_AGENT_WORKER_QUORUM_ID must be set together");
  if (!authorizationPrivateKey || !workerQuorumId) return undefined;
  if (!optional(source.PRIVY_APP_ID) || !optional(source.PRIVY_APP_SECRET)) throw new Error("Agent signing requires Privy credentials");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(workerQuorumId)) throw new Error("PRIVY_AGENT_WORKER_QUORUM_ID is invalid");
  try {
    const bytes = Buffer.from(authorizationPrivateKey, "base64");
    if (bytes.toString("base64") !== authorizationPrivateKey) throw new Error();
    const key = createPrivateKey({ key: bytes, type: "pkcs8", format: "der" });
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1" || !key.export({ format: "der", type: "pkcs8" }).equals(bytes)) throw new Error();
    return { authorizationPrivateKey, workerQuorumId, authorizationPublicKey: createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64") };
  } catch { throw new Error("PRIVY_AGENT_AUTHORIZATION_KEY must be a canonical base64 P256 PKCS8 private key"); }
}
/** The deployment's caps on actual copies, each applied as the stricter of
 * this value and the newest risk policy's (copy-live-caps.ts). */
export interface LiveCopyCaps {
  /** Actual copies one owner may hold (COPY_LIVE_MAX_STRATEGIES_PER_USER,
   * default 2): the per-user limit and the startup capacity check. */
  maxStrategiesPerUser: number;
  /** Largest budget of one copy, its top-ups included
   * (COPY_LIVE_MAX_ALLOCATION_USD; unset: the risk policy's alone). */
  maxAllocationUsd?: number;
  /** Fixed sizing only, with the per-trade amount inside these bounds
   * (COPY_LIVE_FIXED_PER_TRADE_MIN_USD / _MAX_USD; testnet only, unset
   * unless both are set). */
  fixedPerTradeUsd?: { min: number; max: number };
  /** Ratio sizing only (always on a `live` deployment, Paul 2026-10-11):
   * one way to size real-money copies, as CopyDog; an order the exchange's
   * 10 USDC minimum rounds to nothing is skipped and recorded. */
  ratioOnly?: boolean;
  /** Highest leverage a copy may use (COPY_LIVE_MAX_LEVERAGE; default 3 on a
   * `live` deployment, unset on testnet: the risk policy's alone). */
  maxLeverage?: number;
}
export interface LiveCopyConfig {
  /** The one network every actual copy of this deployment executes on
   * (HYPERLIQUID_NETWORK): wallets, agents, the master policy, orders,
   * cancellations, returns and the order budget. */
  network: "mainnet" | "testnet";
  /** Privy users who may start an actual copy (COPY_LIVE_ALLOWED_PRIVY_USER_IDS,
   * comma-separated). Required on a `live` deployment; unset on testnet:
   * everyone. Everyone else keeps paper. */
  allowedPrivyUserIds?: ReadonlySet<string>;
  caps: LiveCopyCaps;
  /** Whether a setup approves the builder fee (off on a `live` deployment for
   * now: the builder step is skipped). */
  builderFee: boolean;
  /** How often a testnet leader's fills are polled over REST
   * (COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS, default 60000; 3000 for the
   * testnet harness). */
  testnetSourceIntervalMs: number;
  /** How long a grant whose revocation an admin requested stays usable for
   * its copy's stop before it is revoked anyway (COPY_LIVE_REVOKE_DEADLINE_MINUTES). */
  revokeDeadlineMs?: number;
  /** Largest mid difference between the leader's network and the execution
   * network at which a leader's open is still mirrored, when the two differ
   * (COPY_TESTNET_MAX_PRICE_DEVIATION_BPS). */
  maxSourceDeviationBps: number;
  /** IOC limit distance from the execution network's mid (COPY_LIVE_SLIPPAGE_BPS). */
  slippageBps: number;
  /** One live worker pass every this many ms (COPY_LIVE_INTERVAL_MS). */
  intervalMs: number;
  /** Testnet REST weight per minute for execution reads
   * (COPY_LIVE_WEIGHT_PER_MIN). Testnet is a separate host with its own
   * per-IP limit, so these reads take their own budget and shared egress
   * key (`<HYPERLIQUID_EGRESS_KEY>:testnet`), never the mainnet watcher's.
   * The burst is the rest of the 1200/min limit (default 300/min, burst 900).
   * One order's evidence reads now weigh 385 (shared reads; 424 with three
   * other coins open, at most 450) and its settlement about 350 (the
   * account observation 284, its own receipts about 45 after the unused list
   * surcharge is given back, the market and the order status 22): about 735
   * an order. At most 700/min: about one order a minute sustained, while the
   * 500 burst still takes one order's evidence at once and the api process
   * (setups, wallet pages) keeps room under the per-IP limit the shared meter
   * enforces across both processes. */
  weightPerMin: number;
  /** Mainnet leaders whose copy signal comes from the realtime fast source
   * (COPY_LIVE_FAST_SOURCE: comma-separated addresses, or `all`). Unset or
   * empty: every mainnet leader keeps the watcher-verified source. A testnet
   * leader is always read from REST, every testnetSourceIntervalMs. */
  fastSource?: { leaders: "all" | ReadonlySet<string>; graceMs: number };
  /** The setup driver's lease, step budget and retries (live-timings.ts;
   * COPY_LIVE_SETUP_*). Startup refuses a step budget that exceeds the lease.
   * Always set when loaded; a hand-built config without it reads the defaults. */
  setup?: LiveSetupTimings;
  /** The stop worker's checks and retries (live-timings.ts; COPY_LIVE_STOP_*). */
  stop?: LiveStopTimings;
}
/** COPY_LIVE_FAST_SOURCE: `all`, or comma-separated 0x addresses. */
function fastSourceLeaders(raw: string | undefined): "all" | ReadonlySet<string> | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value === "all") return "all";
  const leaders = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (!leaders.every((leader) => /^0x[0-9a-f]{40}$/.test(leader))) throw new Error("COPY_LIVE_FAST_SOURCE must be `all` or comma-separated 0x addresses");
  return new Set(leaders);
}
function privyUserIds(raw: string | undefined): ReadonlySet<string> | undefined {
  const ids = (raw ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  if (!ids.length) return undefined;
  if (!ids.every((id) => /^did:privy:[A-Za-z0-9_-]{1,128}$/.test(id))) throw new Error("COPY_LIVE_ALLOWED_PRIVY_USER_IDS must be comma-separated did:privy: ids");
  return new Set(ids);
}
function liveCaps(source: Environment, mode: "testnet" | "live"): LiveCopyCaps {
  const live = mode === "live";
  const fixedMin = optional(source.COPY_LIVE_FIXED_PER_TRADE_MIN_USD), fixedMax = optional(source.COPY_LIVE_FIXED_PER_TRADE_MAX_USD);
  if (!live && Boolean(fixedMin) !== Boolean(fixedMax)) throw new Error("COPY_LIVE_FIXED_PER_TRADE_MIN_USD and COPY_LIVE_FIXED_PER_TRADE_MAX_USD must be set together");
  // Real-money copies size by ratio only: the fixed bounds (still set on
  // Stage from the fixed-amount trial) no longer apply there.
  const fixedPerTradeUsd = !live && fixedMin ? {
    // At least 11 (Hyperliquid's 10 USDC minimum with rounding room).
    min: decimalValue("COPY_LIVE_FIXED_PER_TRADE_MIN_USD", fixedMin, 12, 11, 1_000_000),
    max: decimalValue("COPY_LIVE_FIXED_PER_TRADE_MAX_USD", fixedMax, 15, 11, 1_000_000),
  } : undefined;
  if (fixedPerTradeUsd && fixedPerTradeUsd.min > fixedPerTradeUsd.max) throw new Error("COPY_LIVE_FIXED_PER_TRADE_MIN_USD must not exceed COPY_LIVE_FIXED_PER_TRADE_MAX_USD");
  const maxAllocation = optional(source.COPY_LIVE_MAX_ALLOCATION_USD), maxLeverage = optional(source.COPY_LIVE_MAX_LEVERAGE);
  return {
    maxStrategiesPerUser: integerValue("COPY_LIVE_MAX_STRATEGIES_PER_USER", source.COPY_LIVE_MAX_STRATEGIES_PER_USER, 2, 1, 50),
    ...(maxAllocation ? { maxAllocationUsd: decimalValue("COPY_LIVE_MAX_ALLOCATION_USD", maxAllocation, 0, 1, 10_000_000) } : {}),
    ...(fixedPerTradeUsd ? { fixedPerTradeUsd } : {}),
    ...(live ? { ratioOnly: true } : {}),
    ...(live || maxLeverage ? { maxLeverage: integerValue("COPY_LIVE_MAX_LEVERAGE", maxLeverage, 3, 1, 50) } : {}),
  };
}
export type CopyTradingMode = "paper" | "disabled" | "testnet" | "live";
/**
 * COPY_TRADING_MODE is the deployment's copy capability: `paper` (default:
 * virtual balances, simulated fills), `disabled`, `testnet` or `live`. With
 * `testnet` or `live`, paper keeps working and dedicated copies also execute
 * real orders on HYPERLIQUID_NETWORK (`testnet` / `mainnet` respectively;
 * `live` also needs COPY_LIVE_ALLOWED_PRIVY_USER_IDS). Both need the worker's
 * Privy signing key and quorum and a shared egress key; a missing one refuses
 * startup rather than running as paper.
 */
/**
 * COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS (optional, 5000..10000): the live
 * path's evidence window on a TESTNET deployment (config/live-evidence-window.ts).
 * Testnet lists 273 perp dexes (mainnet 11), so its order evidence took
 * 4.7–5.1 s (gate 11, 2026-10-16). Refused whenever the execution network
 * (HYPERLIQUID_NETWORK: where orders, setups and stops go; COPY_TRADING_MODE=live
 * requires mainnet) is mainnet, whose window is always LIVE_EVIDENCE_MAX_AGE_MS.
 * Unset: LIVE_EVIDENCE_MAX_AGE_MS everywhere.
 */
function testnetEvidenceMaxAgeMs(source: Environment, wallet: "mainnet" | "testnet"): number | undefined {
  const key = "COPY_LIVE_TESTNET_EVIDENCE_MAX_AGE_MS", raw = source[key];
  if (raw === undefined) return undefined;
  if (wallet !== "testnet") throw new Error(`${key} is testnet only: the execution network (HYPERLIQUID_NETWORK) is ${wallet}, whose evidence window is always ${LIVE_EVIDENCE_MAX_AGE_MS} ms`);
  return integerValue(key, raw, LIVE_EVIDENCE_MAX_AGE_MS, LIVE_EVIDENCE_MAX_AGE_MS, LIVE_TESTNET_EVIDENCE_MAX_AGE_CAP_MS);
}
/** `signs`: this process signs (the api, a worker that runs copy work); the
 * `read` worker does not, so it neither needs nor parses the agent key. */
function copyTrading(source: Environment, wallet: "mainnet" | "testnet", egressKey: string | undefined, signs: boolean):
  { mode: CopyTradingMode; workerIntervalMs: number; agent?: AgentSigningConfig; live?: LiveCopyConfig; testnetEvidenceMaxAgeMs?: number } {
  const testnetEvidence = testnetEvidenceMaxAgeMs(source, wallet);
  const mode = (source.COPY_TRADING_MODE ?? "paper").trim().toLowerCase();
  if (mode !== "paper" && mode !== "disabled" && mode !== "testnet" && mode !== "live") throw new Error("COPY_TRADING_MODE must be paper, testnet, live or disabled");
  const agent = signs ? agentSigning(source) : undefined;
  let live: LiveCopyConfig | undefined;
  if (mode === "testnet" || mode === "live") {
    const name = `COPY_TRADING_MODE=${mode}`, network = mode === "live" ? "mainnet" : "testnet";
    if (wallet !== network) throw new Error(`${name} requires HYPERLIQUID_NETWORK=${network}`);
    if (signs && !agent) throw new Error(`${name} requires PRIVY_AGENT_AUTHORIZATION_KEY and PRIVY_AGENT_WORKER_QUORUM_ID`);
    if (!egressKey) throw new Error(`${name} requires HYPERLIQUID_EGRESS_KEY (shared by the api and the worker)`);
    const allowedPrivyUserIds = privyUserIds(source.COPY_LIVE_ALLOWED_PRIVY_USER_IDS);
    if (mode === "live" && !allowedPrivyUserIds) throw new Error("COPY_TRADING_MODE=live requires COPY_LIVE_ALLOWED_PRIVY_USER_IDS (the Privy users who may copy with real funds)");
    live = {
      network,
      ...(allowedPrivyUserIds ? { allowedPrivyUserIds } : {}),
      caps: liveCaps(source, mode),
      builderFee: mode !== "live",
      testnetSourceIntervalMs: integerValue("COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS", source.COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS, 60_000, 1000, 600_000),
      maxSourceDeviationBps: integerValue("COPY_TESTNET_MAX_PRICE_DEVIATION_BPS", source.COPY_TESTNET_MAX_PRICE_DEVIATION_BPS, 500, 0, 10_000),
      slippageBps: integerValue("COPY_LIVE_SLIPPAGE_BPS", source.COPY_LIVE_SLIPPAGE_BPS, 30, 0, 500),
      intervalMs: integerValue("COPY_LIVE_INTERVAL_MS", source.COPY_LIVE_INTERVAL_MS, 3000, 1000, 60_000),
      // At most 485: the wallet network's buckets (order and setup) hold
      // 1200 − this at once, and a setup's account-mode step takes 715 in one
      // reservation (1200 − 715); above it the api and worker refuse to start.
      weightPerMin: integerValue("COPY_LIVE_WEIGHT_PER_MIN", source.COPY_LIVE_WEIGHT_PER_MIN, 300, 100, MAX_COPY_LIVE_WEIGHT_PER_MIN),
      revokeDeadlineMs: integerValue("COPY_LIVE_REVOKE_DEADLINE_MINUTES", source.COPY_LIVE_REVOKE_DEADLINE_MINUTES, 30, 1, 1440) * 60_000,
      setup: liveSetupTimings(source),
      stop: liveStopTimings(source),
    };
    const fast = fastSourceLeaders(source.COPY_LIVE_FAST_SOURCE);
    // G: a read certifies fills only up to this long before it was sent
    // (the fill index trails the exchange; measured p99.9 on mainnet).
    if (fast) live.fastSource = { leaders: fast, graceMs: integerValue("COPY_LIVE_FAST_SOURCE_GRACE_MS", source.COPY_LIVE_FAST_SOURCE_GRACE_MS, FAST_SOURCE_GRACE_MS, 0, 60_000) };
  }
  return {
    mode,
    workerIntervalMs: integerValue("COPY_WORKER_INTERVAL_MS", source.COPY_WORKER_INTERVAL_MS, 2000, 250, 60_000),
    agent, ...(live ? { live } : {}),
    ...(testnetEvidence === undefined ? {} : { testnetEvidenceMaxAgeMs: testnetEvidence }),
  };
}


function decimalValue(key: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw.trim());
  if (!/^\d+(?:\.\d+)?$/.test(raw.trim()) || !Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be a number between ${min} and ${max}`);
  }
  return parsed;
}

function trust(raw: string | undefined): "none" | "regular" | "all" {
  const value = (raw ?? "regular").trim().toLowerCase();
  if (value !== "none" && value !== "regular" && value !== "all") throw new Error("S3_ARCHIVE_TRUST must be none, regular or all");
  return value;
}
/**
 * Hyperliquid's public node archive (requester-pays S3). Off unless
 * S3_ARCHIVE_ENABLED=true. Transfers are billed to the AWS account of
 * AWS_ACCESS_KEY_ID, so the spend settings are validated here, before any
 * request: S3_ARCHIVE_MAX_DAILY_USD caps a UTC day's downloads at
 * S3_ARCHIVE_USD_PER_GB, and S3_ARCHIVE_MAX_BYTES_PER_MINUTE paces them.
 * S3_ARCHIVE_LOCAL_DIR reads the same keys from disk instead (no AWS).
 */
function archive(source: Environment) {
  const enabled = booleanValue("S3_ARCHIVE_ENABLED", source.S3_ARCHIVE_ENABLED, false);
  const accessKeyId = optional(source.AWS_ACCESS_KEY_ID);
  const secretAccessKey = optional(source.AWS_SECRET_ACCESS_KEY);
  const localDir = optional(source.S3_ARCHIVE_LOCAL_DIR);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together");
  if (enabled && !localDir && !accessKeyId) throw new Error("S3_ARCHIVE_ENABLED requires AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or S3_ARCHIVE_LOCAL_DIR");
  const startRaw = optional(source.S3_ARCHIVE_START) ?? "2025-05-25";
  const start = /^\d{4}-\d{2}-\d{2}$/.test(startRaw) ? Date.parse(`${startRaw}T00:00:00Z`) : Number.NaN;
  if (!Number.isFinite(start)) throw new Error("S3_ARCHIVE_START must be a UTC date, YYYY-MM-DD");
  const bucket = optional(source.S3_ARCHIVE_BUCKET) ?? "hl-mainnet-node-data";
  const region = optional(source.S3_ARCHIVE_REGION) ?? "ap-northeast-1";
  if (!/^[a-z0-9.-]{3,63}$/.test(bucket) || !/^[a-z0-9-]{3,32}$/.test(region)) throw new Error("S3_ARCHIVE_BUCKET or S3_ARCHIVE_REGION is invalid");
  return {
    enabled, bucket, region, localDir, start,
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey, sessionToken: optional(source.AWS_SESSION_TOKEN) } : undefined,
    maxDailyUsd: decimalValue("S3_ARCHIVE_MAX_DAILY_USD", source.S3_ARCHIVE_MAX_DAILY_USD, 2, 0, 1000),
    usdPerGb: decimalValue("S3_ARCHIVE_USD_PER_GB", source.S3_ARCHIVE_USD_PER_GB, 0.114, 0, 10),
    maxBytesPerMinute: integerValue("S3_ARCHIVE_MAX_BYTES_PER_MINUTE", source.S3_ARCHIVE_MAX_BYTES_PER_MINUTE, 268_435_456, 1, 10_737_418_240),
    /** Which REST history streams may skip ranges the archive certifies:
     * "regular" (default; fills), "all" (also TWAP slices — only once a
     * reconciliation has shown the archive carries them) or "none". */
    trust: trust(source.S3_ARCHIVE_TRUST),
    /** false: only the forward cursor runs (no backfill passes). */
    backfill: booleanValue("S3_ARCHIVE_BACKFILL_ENABLED", source.S3_ARCHIVE_BACKFILL_ENABLED, true),
    /** How far back a pass goes: this many UTC days before today, never
     * before `start`. Raising it later extends every span with a new pass. */
    backfillDays: integerValue("S3_ARCHIVE_BACKFILL_DAYS", source.S3_ARCHIVE_BACKFILL_DAYS, 90, 1, 3650),
    /** Least time between the starts of two passes. A pass re-downloads
     * every hour of the window for the addresses that joined since the
     * previous one, so this bounds what joiners cost; 0: back to back. */
    passIntervalHours: integerValue("S3_ARCHIVE_PASS_INTERVAL_HOURS", source.S3_ARCHIVE_PASS_INTERVAL_HOURS, 168, 0, 8760),
    /** Minutes after an hour ends before its object is read. */
    settleMinutes: integerValue("S3_ARCHIVE_SETTLE_MINUTES", source.S3_ARCHIVE_SETTLE_MINUTES, 20, 0, 1440),
    /** More fills than this in one hourly object: the address is excluded. */
    maxFillsPerAddressHour: integerValue("S3_ARCHIVE_MAX_FILLS_PER_ADDRESS_HOUR", source.S3_ARCHIVE_MAX_FILLS_PER_ADDRESS_HOUR, 0, 0, 10_000_000),
  };
}

/**
 * Deploy-time tuning, read once at startup (a wrong value starves user
 * requests or deletes data, so it is not an admin setting). The weight caps
 * are each loop's allowance inside the process's HYPERLIQUID_WEIGHT_* budget
 * (0 pauses a loop). Retention periods are what the privacy policy (§6) states.
 */
export const TUNING_DEFAULTS = {
  discovery: { leaderboardRefreshMinutes: 15, candidatePoolSize: 1000, cohortMembersPerTier: 500, cohortRefreshMinutes: 40 },
  weights: { poolLedger: 100, poolPerformance: 240, history: 120, backfill: 120, cohort: 150 },
  retention: { enabled: true, snapshotDays: 90, auditDays: 365, accountDeletionDays: 365, queueDays: 30, alertDays: 30,
    copyEquityFullDays: 31, cohortMemberListDays: 30, followerObservationDays: 7, historyFillDays: 90 },
} as const;
export function tuningConfig(source: Environment = {}) {
  const d = TUNING_DEFAULTS;
  return {
    discovery: {
      leaderboardRefreshMinutes: integerValue("DISCOVERY_LEADERBOARD_REFRESH_MINUTES", source.DISCOVERY_LEADERBOARD_REFRESH_MINUTES, d.discovery.leaderboardRefreshMinutes, 5, 240),
      candidatePoolSize: integerValue("DISCOVERY_CANDIDATE_POOL_SIZE", source.DISCOVERY_CANDIDATE_POOL_SIZE, d.discovery.candidatePoolSize, 50, 5000),
      cohortMembersPerTier: integerValue("DISCOVERY_COHORT_MEMBERS_PER_TIER", source.DISCOVERY_COHORT_MEMBERS_PER_TIER, d.discovery.cohortMembersPerTier, 0, 2000),
      cohortRefreshMinutes: integerValue("DISCOVERY_COHORT_REFRESH_MINUTES", source.DISCOVERY_COHORT_REFRESH_MINUTES, d.discovery.cohortRefreshMinutes, 5, 240),
    },
    weights: {
      poolLedger: integerValue("HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN", source.HYPERLIQUID_POOL_LEDGER_WEIGHT_PER_MIN, d.weights.poolLedger, 0, 600),
      poolPerformance: integerValue("HYPERLIQUID_POOL_PERFORMANCE_WEIGHT_PER_MIN", source.HYPERLIQUID_POOL_PERFORMANCE_WEIGHT_PER_MIN, d.weights.poolPerformance, 0, 600),
      history: integerValue("HYPERLIQUID_HISTORY_WEIGHT_PER_MIN", source.HYPERLIQUID_HISTORY_WEIGHT_PER_MIN, d.weights.history, 0, 600),
      backfill: integerValue("HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN", source.HYPERLIQUID_BACKFILL_WEIGHT_PER_MIN, d.weights.backfill, 0, 600),
      cohort: integerValue("HYPERLIQUID_COHORT_WEIGHT_PER_MIN", source.HYPERLIQUID_COHORT_WEIGHT_PER_MIN, d.weights.cohort, 0, 600),
    },
    retention: {
      enabled: booleanValue("RETENTION_ENABLED", source.RETENTION_ENABLED, d.retention.enabled),
      snapshotDays: integerValue("RETENTION_SNAPSHOT_DAYS", source.RETENTION_SNAPSHOT_DAYS, d.retention.snapshotDays, 30, 3650),
      auditDays: integerValue("RETENTION_AUDIT_DAYS", source.RETENTION_AUDIT_DAYS, d.retention.auditDays, 30, 3650),
      accountDeletionDays: integerValue("RETENTION_ACCOUNT_DELETION_DAYS", source.RETENTION_ACCOUNT_DELETION_DAYS, d.retention.accountDeletionDays, 30, 3650),
      queueDays: integerValue("RETENTION_QUEUE_DAYS", source.RETENTION_QUEUE_DAYS, d.retention.queueDays, 7, 3650),
      alertDays: integerValue("RETENTION_ALERT_DAYS", source.RETENTION_ALERT_DAYS, d.retention.alertDays, 7, 3650),
      // The api reads a paper copy's valuations as thinned from COPY_EQUITY_FULL_RESOLUTION_MS before its end: not below.
      copyEquityFullDays: integerValue("RETENTION_COPY_EQUITY_FULL_DAYS", source.RETENTION_COPY_EQUITY_FULL_DAYS, d.retention.copyEquityFullDays,
        COPY_EQUITY_FULL_RESOLUTION_MS / DAY_MS, 3650),
      cohortMemberListDays: integerValue("RETENTION_COHORT_MEMBER_LIST_DAYS", source.RETENTION_COHORT_MEMBER_LIST_DAYS, d.retention.cohortMemberListDays, 7, 3650),
      followerObservationDays: integerValue("RETENTION_FOLLOWER_OBSERVATION_DAYS", source.RETENTION_FOLLOWER_OBSERVATION_DAYS, d.retention.followerObservationDays, 1, 3650),
      // At least 30: the trader figures' 30-day window must stay whole.
      historyFillDays: integerValue("RETENTION_HISTORY_FILL_DAYS", source.RETENTION_HISTORY_FILL_DAYS, d.retention.historyFillDays, 30, 3650),
    },
  };
}
export type TuningConfig = ReturnType<typeof tuningConfig>;

function productionSecret(key: string, value: string | undefined, production: boolean): void {
  if (!production || value === undefined) return;
  if (value.trim().length < 32 || /change[-_ ]?me|your[-_ ]?secret|replace[-_ ]?with|example|placeholder/i.test(value)) {
    throw new Error(`${key} must be a strong, non-placeholder secret in production/staging`);
  }
}

/** Validate before Nest constructs any DB client, watcher or bot. No I/O. */
export function validateEnvironment(source: Environment = process.env) {
  const nodeEnv = source.NODE_ENV ?? "development";
  if (!["development", "test", "staging", "production"].includes(nodeEnv)) throw new Error("NODE_ENV is invalid");
  const production = nodeEnv === "production" || nodeEnv === "staging";
  const trustedProxyCidrs = (source.API_TRUSTED_PROXY_CIDRS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  for (const cidr of trustedProxyCidrs) {
    const [address, mask, extra] = cidr.split("/");
    const version = isIP(address!);
    if (!version || extra !== undefined || (mask !== undefined && (!/^\d+$/.test(mask) || Number(mask) < 1 || Number(mask) > (version === 4 ? 32 : 128)))) {
      throw new Error("API_TRUSTED_PROXY_CIDRS must contain explicit IP addresses or non-universal CIDRs");
    }
  }
  // One switch, as in DonutMe: IS_WORKER=true runs the background jobs and
  // serves only health; unset (or false) is the HTTP api, which starts none.
  const isWorker = booleanValue("IS_WORKER", source.IS_WORKER, false);
  // A leftover APP_ROLE is tolerated only when it says the same thing as
  // IS_WORKER, so a deployment can switch image and variables in either order
  // (removing a Railway variable redeploys the previous image). combined is
  // gone: a process must never run the api and the jobs together again.
  if (source.APP_ROLE !== undefined && source.APP_ROLE !== (isWorker ? "worker" : "api")) {
    throw new Error("APP_ROLE was replaced by IS_WORKER: set IS_WORKER=true on the worker and remove APP_ROLE");
  }
  const workerUrl = source.WORKER_URL ? urlValue("WORKER_URL", source.WORKER_URL, "", ["http:", "https:"]) : undefined;
  // WORKER_READ_URL (optional): the `read` worker once the roles are split;
  // WORKER_URL is then the `copy` worker. The api reads both heartbeats and
  // merges them (WorkerFleetService); unset, WORKER_URL's alone, as before.
  const workerReadUrl = source.WORKER_READ_URL ? urlValue("WORKER_READ_URL", source.WORKER_READ_URL, "", ["http:", "https:"]) : undefined;
  // WORKER_ROLE (runtime/worker-role.ts): unset is `all`, today's worker. A
  // role on the api would mean nothing, so a set one is refused there.
  const workerRole = workerRoleValue(source.WORKER_ROLE);
  if (!isWorker && optional(source.WORKER_ROLE) !== undefined) throw new Error("WORKER_ROLE applies to the worker only (IS_WORKER=true)");
  // The Privy variables belong to the processes that sign or verify with
  // them: the api (sign-in, user flows, setups under API_SETUP_DRIVE=local)
  // and a worker that runs copy work (`copy`, `all`). The `read` worker never
  // does (runtime/worker-role.ts), so it starts without them and, given
  // them, ignores them with one warning (`warnings`, logged at startup)
  // rather than carrying live credentials it has no use for.
  const signs = !isWorker || runsCopy(workerRole);
  const warnings: string[] = [];
  const ignoredPrivy = signs ? [] : PRIVY_VARIABLES.filter((name) => optional(source[name]) !== undefined);
  if (ignoredPrivy.length) warnings.push(`WORKER_ROLE=read never signs or verifies with Privy: ${ignoredPrivy.join(", ")} set but ignored; remove them from this service`);
  // API_SETUP_DRIVE: `local` (default, today) drives a setup inside the
  // api's confirm/advance; `worker` only marks it due and wakes the copy
  // worker (NOTIFY copy_setup_due, copy/copy-setup-due.ts).
  const setupDrive = oneOf("API_SETUP_DRIVE", source.API_SETUP_DRIVE, ["local", "worker"], "local");
  // Terminal settlement runs only on the copy worker (its live engine settles
  // every terminal order itself, on both networks; decision D13, 2026-10-23):
  // the api has no settlement loop and no switch for one.
  const app = { isWorker, workerUrl, workerReadUrl, nodeEnv, trustedProxyCidrs, workerRole, setupDrive,
  // A worker beside an api on one machine needs its own port: WORKER_PORT
  // wins for the worker (Railway sets PORT per service and leaves it unset).
  port: isWorker && source.WORKER_PORT ? integerValue("WORKER_PORT", source.WORKER_PORT, 3000, 1, 65535) : integerValue("PORT", source.PORT, 3000, 1, 65535) };
  // The main pool's size (DATABASE_POOL_MAX), by default per process and
  // worker role (config/constants/database.ts): api 10, copy 20, read 10
  // (all 30). With a rolling-deploy overlap and the migration they stay under
  // Postgres's default max_connections of 100 (docs/railway-deploy.md).
  const defaultPoolMax = !isWorker ? DATABASE_POOL_MAX_API
    : workerRole === "copy" ? DATABASE_POOL_MAX_COPY_WORKER : workerRole === "read" ? DATABASE_POOL_MAX_READ_WORKER : DATABASE_POOL_MAX_WORKER;
  const database = { url: databaseUrl(source.DATABASE_URL),
    poolMax: integerValue("DATABASE_POOL_MAX", source.DATABASE_POOL_MAX, defaultPoolMax, 2, 200) };
  const serviceToken = optional(source.AUTH_SERVICE_TOKEN);
  const permissions = servicePermissions(source.AUTH_SERVICE_PERMISSIONS);
  if (permissions.length && !serviceToken) throw new Error("AUTH_SERVICE_TOKEN is required when AUTH_SERVICE_PERMISSIONS is set");
  productionSecret("AUTH_SERVICE_TOKEN", serviceToken, production);
  const adminEmails = (source.AUTH_ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw new Error("AUTH_ADMIN_EMAILS must contain email addresses");
  const appId = signs ? optional(source.PRIVY_APP_ID) : undefined;
  const appSecret = signs ? optional(source.PRIVY_APP_SECRET) : undefined;
  if (Boolean(appId) !== Boolean(appSecret)) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be set together");
  // The deletion markers' own key (deletion-markers.ts); unset keeps the key
  // derived from PRIVY_APP_SECRET. A rotated key stays in PREVIOUS_KEYS for
  // the retention window.
  const markerKey = optional(source.ACCOUNT_DELETION_MARKER_KEY);
  const previousMarkerKeys = (source.ACCOUNT_DELETION_MARKER_PREVIOUS_KEYS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (previousMarkerKeys.length && !markerKey) throw new Error("ACCOUNT_DELETION_MARKER_PREVIOUS_KEYS requires ACCOUNT_DELETION_MARKER_KEY");
  productionSecret("ACCOUNT_DELETION_MARKER_KEY", markerKey, production);
  const deletionMarker = { key: markerKey, previousKeys: previousMarkerKeys };
  const verificationKey = signs ? optional(source.PRIVY_VERIFICATION_KEY)?.replace(/\\n/g, "\n") : undefined;
  if (verificationKey) {
    if (!appId) throw new Error("PRIVY_VERIFICATION_KEY requires configured Privy credentials");
    try {
      const key = createPublicKey(verificationKey);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    } catch { throw new Error("PRIVY_VERIFICATION_KEY must be an ES256 public key"); }
  }
  const botToken = optional(source.TELEGRAM_BOT_TOKEN);
  const botUsername = optional(source.TELEGRAM_BOT_USERNAME)?.replace(/^@/, "");
  const dryRun = booleanValue("TELEGRAM_DRY_RUN", source.TELEGRAM_DRY_RUN, true);
  const polling = booleanValue("TELEGRAM_BOT_POLLING", source.TELEGRAM_BOT_POLLING, true);
  if (botToken && (!botUsername || !/^[a-zA-Z0-9_]{5,32}$/.test(botUsername))) throw new Error("TELEGRAM_BOT_USERNAME is required and must be a valid bot username when a token is configured");
  if (!dryRun && !botToken) throw new Error("TELEGRAM_BOT_TOKEN is required when TELEGRAM_DRY_RUN is false");
  const telegram = { botToken, botUsername, dryRun, polling, systemChatId: optional(source.TELEGRAM_SYSTEM_CHAT_ID),
    linkBaseUrl: urlValue("TELEGRAM_LINK_BASE_URL", source.TELEGRAM_LINK_BASE_URL, "https://app.orbie.fun", ["http:", "https:"]),
  };
  const sharedEgressKey = optional(source.HYPERLIQUID_EGRESS_KEY);
  if (source.HYPERLIQUID_EGRESS_KEY !== undefined && (!sharedEgressKey || !/^[A-Za-z0-9:._-]{1,128}$/.test(sharedEgressKey))) throw new Error('HYPERLIQUID_EGRESS_KEY must be a canonical shared egress identifier');
  // `<key>:read` is the read worker's own meter (below): a shared key that
  // already carries the segment would put the copy side on it.
  if (sharedEgressKey && isReadMeterKey(sharedEgressKey)) throw new Error("HYPERLIQUID_EGRESS_KEY must not contain a `read` segment: `<key>:read` is the read worker's own meter (HYPERLIQUID_READ_METER)");
  // The shared quota refuses every info call without the alias: fail at
  // startup rather than pass readiness and then fail every read.
  if (production && !sharedEgressKey) throw new Error("HYPERLIQUID_EGRESS_KEY is required in staging and production (the same value on the api and the worker)");
  // HYPERLIQUID_READ_METER (decision D12, 2026-10-23; hyperliquid-meter-key.ts):
  // the read worker's meter. `own` (default): its own public IP's 1,200 a
  // minute under `<HYPERLIQUID_EGRESS_KEY>:read`, background capped at
  // READ_WORKER_BACKGROUND_REST_CAP (900) so READ_WORKER_PAGE_RESERVE (300)
  // stays for its on-demand reads. `shared`: the rollback, back on the copy
  // side's meter with its priorities, as before D12 (if Hyperliquid counts
  // the two IPs together). Meaningless anywhere else, so refused there.
  const readMeter = oneOf("HYPERLIQUID_READ_METER", source.HYPERLIQUID_READ_METER, ["shared", "own"], "own");
  const readWorker = isWorker && workerRole === "read";
  if (optional(source.HYPERLIQUID_READ_METER) !== undefined && !readWorker) throw new Error("HYPERLIQUID_READ_METER applies to the read worker only (IS_WORKER=true, WORKER_ROLE=read)");
  const meter: HyperliquidMeter = readWorker && readMeter === "own" ? "read" : "copy";
  const egressKey = meter === "read" && sharedEgressKey ? readMeterKey(sharedEgressKey) : sharedEgressKey;
  // The read meter's background cap is the constant: a value copied from the
  // copy side (a canary's 400) would starve it again, silently.
  if (meter === "read" && source.HYPERLIQUID_BACKGROUND_REST_CAP !== undefined) throw new Error(`HYPERLIQUID_BACKGROUND_REST_CAP does not apply to the read worker's own meter (READ_WORKER_BACKGROUND_REST_CAP, ${READ_WORKER_BACKGROUND_REST_CAP}): delete it on worker-read, or set HYPERLIQUID_READ_METER=shared`);
  const wallet = walletNetwork(source), mainnetWorker = isWorker && wallet.network === "mainnet";
  // The read meter's local bucket may spend what its background cap allows
  // (its own IP); HYPERLIQUID_WORKER_WEIGHT_* (one machine, one .env) else
  // HYPERLIQUID_WEIGHT_* may lower it, never raise it above the cap.
  const readRate = source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN !== undefined ? ["HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN] as const : ["HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN] as const;
  const readBurst = source.HYPERLIQUID_WORKER_WEIGHT_BURST !== undefined ? ["HYPERLIQUID_WORKER_WEIGHT_BURST", source.HYPERLIQUID_WORKER_WEIGHT_BURST] as const : ["HYPERLIQUID_WEIGHT_BURST", source.HYPERLIQUID_WEIGHT_BURST] as const;
  const hyperliquid = {
    /** The meter this process charges (hyperliquid-meter-key.ts): the shared
     * one (`copy`: the api and the copy worker, HYPERLIQUID_EGRESS_KEY) or the
     * read worker's own (`read`: `<key>:read`). Missing configuration never
     * grants unmetered actual execution. */
    egressKey,
    /** HYPERLIQUID_EGRESS_KEY as set: the copy side's shared meter, which the
     * admin overview shows beside the read meter derived from it. */
    sharedEgressKey,
    meter,
    readMeter,
    apiUrl: urlValue("HYPERLIQUID_API_URL", source.HYPERLIQUID_API_URL, "https://api.hyperliquid.xyz/info", ["http:", "https:"]),
    wsUrl: urlValue("HYPERLIQUID_WS_URL", source.HYPERLIQUID_WS_URL, "wss://api.hyperliquid.xyz/ws", ["ws:", "wss:"]),
    /** This process's share of the per-IP REST limit; the api's and the copy
     * worker's draw on the same meter. A worker reading the api's .env takes
     * HYPERLIQUID_WORKER_WEIGHT_* (as it takes WORKER_PORT). A worker on the
     * MAINNET wallet network always does (MAINNET_WORKER_WEIGHT): copy orders'
     * evidence is paid from this bucket, and one two-account order plus its
     * leader (772) must fit its burst; the startup check refuses otherwise.
     * The read worker on its own meter (D12) has the meter's background cap
     * (READ_WORKER_BACKGROUND_REST_CAP) as rate and burst unless lowered. */
    budgetPerMin: meter === "read" ? integerValue(readRate[0], readRate[1], READ_WORKER_BACKGROUND_REST_CAP, 1, READ_WORKER_BACKGROUND_REST_CAP)
      : isWorker && (mainnetWorker || source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN !== undefined)
      ? integerValue("HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN, MAINNET_WORKER_WEIGHT.perMin, 1, 1199)
      : integerValue("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN, 840, 1, 1199),
    burst: meter === "read" ? integerValue(readBurst[0], readBurst[1], READ_WORKER_BACKGROUND_REST_CAP, 1, READ_WORKER_BACKGROUND_REST_CAP)
      : isWorker && (mainnetWorker || source.HYPERLIQUID_WORKER_WEIGHT_BURST !== undefined)
      ? integerValue("HYPERLIQUID_WORKER_WEIGHT_BURST", source.HYPERLIQUID_WORKER_WEIGHT_BURST, MAINNET_WORKER_WEIGHT.burst, 1, 1200)
      : integerValue("HYPERLIQUID_WEIGHT_BURST", source.HYPERLIQUID_WEIGHT_BURST, 200, 1, 1200),
    /** Share of the budget rate the page reserve keeps refilling at while
     * page work is over its share of the minute: the floor pages always get. */
    pageReserveShare: decimalValue("HYPERLIQUID_PAGE_RESERVE_SHARE", source.HYPERLIQUID_PAGE_RESERVE_SHARE, 0.25, 0.05, 0.9),
    /** A real-money bucket's reserve, as a share of the burst: only `live`
     * (and interactive) calls spend it and it refills first; unset: the page
     * reserve (60 %). Set by the wallet network's own bucket only, never env. */
    ...({} as { liveHeadroomShare?: number }),
    /** A new process sends at a reduced rate, from empty buckets, for this
     * long: during a redeploy the instance it replaces is still spending
     * the same IP limit. 0: full rate and a full burst at once. */
    startupPaceSeconds: integerValue("HYPERLIQUID_STARTUP_PACE_SECONDS", source.HYPERLIQUID_STARTUP_PACE_SECONDS, 60, 0, 600),
    /** What background work may hold of the shared per-IP REST window (the
     * meter, hyperliquid-global-quota.ts); the rest is kept for pages and copy
     * orders. Default 840. On a mainnet copy canary lower it (e.g. 400, the same
     * value on the api and the worker) so one order's evidence (≤ 772 a minute)
     * always finds room. */
    backgroundRestCap: meter === "read" ? READ_WORKER_BACKGROUND_REST_CAP : integerValue("HYPERLIQUID_BACKGROUND_REST_CAP", source.HYPERLIQUID_BACKGROUND_REST_CAP, HYPERLIQUID_BACKGROUND_REST_CAP, 0, 1200),
    wallet,
  };
  const alert = { maxActionAgeSeconds: integerValue("ALERT_MAX_ACTION_AGE_SECONDS", source.ALERT_MAX_ACTION_AGE_SECONDS, 120, 1, 86400) };
  const stream = {
    maxPerIp: integerValue("STREAM_MAX_PER_IP", source.STREAM_MAX_PER_IP, 8, 1, 1000),
    maxTotal: integerValue("STREAM_MAX_TOTAL", source.STREAM_MAX_TOTAL, 500, 1, 100_000),
    trustedProxyHops: integerValue("STREAM_TRUSTED_PROXY_HOPS", source.STREAM_TRUSTED_PROXY_HOPS, 0, 0, 10),
  };
  if (stream.maxPerIp > stream.maxTotal) throw new Error("STREAM_MAX_PER_IP must not exceed STREAM_MAX_TOTAL");
  const corsOrigins = (source.API_CORS_ORIGINS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  for (const origin of corsOrigins) {
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password) throw new Error();
    } catch { throw new Error("API_CORS_ORIGINS must contain exact HTTP(S) origins without paths or credentials"); }
  }
  const http = { corsOrigins };
  const limits = {
    ingressPerMinute: integerValue("API_INGRESS_PER_MINUTE", source.API_INGRESS_PER_MINUTE, 3000, 1, 1000000),
    readPerMinute: integerValue("API_READ_PER_MINUTE", source.API_READ_PER_MINUTE, 300, 1, 1000000),
    writePerMinute: integerValue("API_WRITE_PER_MINUTE", source.API_WRITE_PER_MINUTE, 60, 1, 1000000),
    expensivePerMinute: integerValue("API_EXPENSIVE_PER_MINUTE", source.API_EXPENSIVE_PER_MINUTE, 10, 1, 1000000),
    favoritesPerUser: integerValue("MAX_FAVORITES_PER_USER", source.MAX_FAVORITES_PER_USER, 100, 1, 10000),
  };
  return { app, database, limits, http, auth: { serviceToken, permissions, adminEmails, appId, appSecret, verificationKey, deletionMarker }, telegram, hyperliquid, alert, stream, copy: copyTrading(source, hyperliquid.wallet.network, egressKey, signs), archive: archive(source), tuning: tuningConfig(source),
    egressIdentity: egressIdentityConfig(source, isWorker), warnings };
}

/** The default IP echoes, in order: three independent IPv4-only https hosts
 * answering the address as plain text (icanhazip's ipv4 host so a
 * dual-stack egress never answers IPv6). */
const DEFAULT_EGRESS_ECHO_URLS: readonly string[] = ["https://api.ipify.org", "https://checkip.amazonaws.com", "https://ipv4.icanhazip.com"];

/**
 * The egress identity guard (runtime/egress-identity.ts; design §8 I-15).
 * - HL_EGRESS_IDENTITY: `off` (default) learns nothing; `observe` learns
 *   this process's public IPv4 from an IP echo at startup and every
 *   HL_EGRESS_IDENTITY_INTERVAL_MINUTES (default 5), reports it (heartbeat,
 *   admin overview, GET /health/egress) and logs it, never blocking
 *   anything; `enforce` also makes a worker that runs copy work refuse its
 *   lease while its IP is unknown, outside HL_EGRESS_EXPECTED_IPS, or one
 *   the api or the read worker reports (HL_EGRESS_PEERS).
 * - HL_EGRESS_ECHO_URLS: the echoes tried in order; default
 *   DEFAULT_EGRESS_ECHO_URLS, so one or two being down never keeps a copy
 *   worker on standby under enforce (all down fails closed). Each call is
 *   bounded by HL_EGRESS_ECHO_TIMEOUT_MS (default 3000).
 * - HL_EGRESS_PEERS (copy worker): base URLs of the api and the read
 *   worker, whose GET /health/egress (the worker monitor key) says their IPs.
 *   Required under enforce (at least one): without a peer every lease would
 *   be allowed, so enforce would silently act as observe.
 * - HL_EGRESS_EXPECTED_IPS (copy worker, optional): the static egress
 *   gateway's addresses; an IP outside them means the gateway is not in use.
 */
function egressIdentityConfig(source: Environment, isWorker: boolean) {
  const mode = oneOf("HL_EGRESS_IDENTITY", source.HL_EGRESS_IDENTITY, ["off", "observe", "enforce"], "off");
  if (mode === "enforce" && !isWorker) throw new Error("HL_EGRESS_IDENTITY=enforce applies to the worker only (the api observes)");
  const list = (raw: string | undefined) => (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const echoUrls = list(source.HL_EGRESS_ECHO_URLS);
  const peers = list(source.HL_EGRESS_PEERS);
  // With no peer, egressLeaseVerdict has nothing to compare with and always
  // allows the lease: enforce would act as observe while looking protected.
  if (mode === "enforce" && !peers.length) throw new Error("HL_EGRESS_IDENTITY=enforce needs HL_EGRESS_PEERS (the api's and worker-read's base URLs): with no peer there is nothing to compare with and every lease would be allowed. Set the peers, or use observe");
  const expectedIps = list(source.HL_EGRESS_EXPECTED_IPS);
  if (expectedIps.some((ip) => isIP(ip) !== 4)) throw new Error("HL_EGRESS_EXPECTED_IPS must be IPv4 addresses");
  return {
    mode,
    intervalMs: integerValue("HL_EGRESS_IDENTITY_INTERVAL_MINUTES", source.HL_EGRESS_IDENTITY_INTERVAL_MINUTES, 5, 1, 1440) * 60_000,
    timeoutMs: integerValue("HL_EGRESS_ECHO_TIMEOUT_MS", source.HL_EGRESS_ECHO_TIMEOUT_MS, 3000, 500, 10_000),
    echoUrls: echoUrls.length ? echoUrls.map((url) => urlValue("HL_EGRESS_ECHO_URLS", url, "", ["https:"])) : [...DEFAULT_EGRESS_ECHO_URLS],
    peers: peers.map((url) => urlValue("HL_EGRESS_PEERS", url, "", ["http:", "https:"])),
    expectedIps,
  };
}
export type EgressIdentityConfig = ReturnType<typeof egressIdentityConfig>;
export type RuntimeConfig = ReturnType<typeof validateEnvironment>;
