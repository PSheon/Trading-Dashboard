import { isIP } from "node:net";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { WALLET_NETWORKS } from "@trading-dashboard/shared/contracts";

import { booleanValue, databaseUrl, integerValue, servicePermissions } from "./parse-env.js";

type Environment = Record<string, string | undefined>;
const optional = (value: string | undefined) => value?.trim() || undefined;

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

/**
 * HYPERLIQUID_NETWORK picks where the user's own wallet lives: the network
 * whose balances /me/wallet reads and whose chain the browser signs bridge
 * and withdraw actions for. Default testnet: mainnet signing needs Paul's
 * explicit approval (Stage 4 §6). The discovery reads keep using
 * HYPERLIQUID_API_URL (mainnet) either way.
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

/**
 * COPY_TRADING_MODE is the deployment's copy capability (review #11):
 * `paper` (default: virtual balances, simulated fills), `disabled`, or
 * `testnet`: paper keeps working and, in addition, dedicated testnet copies
 * execute real orders on Hyperliquid TESTNET (leader fills from mainnet or
 * testnet). Testnet execution needs the wallet network on testnet, the
 * worker's Privy signing key and quorum, and a shared egress key; a missing
 * one refuses startup rather than running as paper. `live` (mainnet funds)
 * is refused: it needs the owner's explicit approval, never an env switch.
 */
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
export interface LiveCopyConfig {
  /** How long a grant whose revocation an admin requested stays usable for
   * its copy's stop before it is revoked anyway (COPY_LIVE_REVOKE_DEADLINE_MINUTES). */
  revokeDeadlineMs?: number;
  /** Largest testnet/mainnet mid difference at which a mainnet leader's open
   * is still mirrored on testnet (COPY_TESTNET_MAX_PRICE_DEVIATION_BPS). */
  maxSourceDeviationBps: number;
  /** IOC limit distance from the testnet mid (COPY_LIVE_SLIPPAGE_BPS). */
  slippageBps: number;
  /** One live worker pass every this many ms (COPY_LIVE_INTERVAL_MS). */
  intervalMs: number;
  /** Testnet REST weight per minute for execution reads
   * (COPY_LIVE_WEIGHT_PER_MIN). Testnet is a separate host with its own
   * per-IP limit, so these reads take their own budget and shared egress
   * key (`<HYPERLIQUID_EGRESS_KEY>:testnet`), never the mainnet watcher's.
   * The burst is the rest of the 1200/min limit: one order's fresh evidence
   * reads weigh about 770 and its settlement about 400, so a low rate with
   * a large burst (default 300/min, burst 900) lets one order go at once. */
  weightPerMin: number;
}
function copyTrading(source: Environment, wallet: "mainnet" | "testnet", egressKey: string | undefined):
  { mode: "paper" | "disabled" | "testnet"; workerIntervalMs: number; agent?: AgentSigningConfig; live?: LiveCopyConfig } {
  const mode = (source.COPY_TRADING_MODE ?? "paper").trim().toLowerCase();
  if (mode === "live") throw new Error("COPY_TRADING_MODE=live (mainnet funds) is not available: it needs the owner's explicit approval");
  if (mode !== "paper" && mode !== "disabled" && mode !== "testnet") throw new Error("COPY_TRADING_MODE must be paper, testnet or disabled");
  const agent = agentSigning(source);
  let live: LiveCopyConfig | undefined;
  if (mode === "testnet") {
    if (wallet !== "testnet") throw new Error("COPY_TRADING_MODE=testnet requires HYPERLIQUID_NETWORK=testnet");
    if (!agent) throw new Error("COPY_TRADING_MODE=testnet requires PRIVY_AGENT_AUTHORIZATION_KEY and PRIVY_AGENT_WORKER_QUORUM_ID");
    if (!egressKey) throw new Error("COPY_TRADING_MODE=testnet requires HYPERLIQUID_EGRESS_KEY (shared by the api and the worker)");
    live = {
      maxSourceDeviationBps: integerValue("COPY_TESTNET_MAX_PRICE_DEVIATION_BPS", source.COPY_TESTNET_MAX_PRICE_DEVIATION_BPS, 500, 0, 10_000),
      slippageBps: integerValue("COPY_LIVE_SLIPPAGE_BPS", source.COPY_LIVE_SLIPPAGE_BPS, 30, 0, 500),
      intervalMs: integerValue("COPY_LIVE_INTERVAL_MS", source.COPY_LIVE_INTERVAL_MS, 3000, 1000, 60_000),
      weightPerMin: integerValue("COPY_LIVE_WEIGHT_PER_MIN", source.COPY_LIVE_WEIGHT_PER_MIN, 300, 100, 400),
      revokeDeadlineMs: integerValue("COPY_LIVE_REVOKE_DEADLINE_MINUTES", source.COPY_LIVE_REVOKE_DEADLINE_MINUTES, 30, 1, 1440) * 60_000,
    };
  }
  return {
    mode: mode as "paper" | "disabled" | "testnet",
    workerIntervalMs: integerValue("COPY_WORKER_INTERVAL_MS", source.COPY_WORKER_INTERVAL_MS, 2000, 250, 60_000),
    agent, ...(live ? { live } : {}),
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

/**
 * Hyperliquid's public node archive (requester-pays S3). Off unless
 * S3_ARCHIVE_ENABLED=true. Transfers are billed to the AWS account of
 * AWS_ACCESS_KEY_ID, so the spend settings are validated here, before any
 * request: S3_ARCHIVE_MAX_DAILY_USD caps a UTC day's downloads at
 * S3_ARCHIVE_USD_PER_GB, and S3_ARCHIVE_MAX_BYTES_PER_MINUTE paces them.
 * S3_ARCHIVE_LOCAL_DIR reads the same keys from disk instead (no AWS).
 */
function trust(raw: string | undefined): "none" | "regular" | "all" {
  const value = (raw ?? "regular").trim().toLowerCase();
  if (value !== "none" && value !== "regular" && value !== "all") throw new Error("S3_ARCHIVE_TRUST must be none, regular or all");
  return value;
}
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
  const app = { isWorker, workerUrl, nodeEnv, trustedProxyCidrs,
  // A worker beside an api on one machine needs its own port: WORKER_PORT
  // wins for the worker (Railway sets PORT per service and leaves it unset).
  port: isWorker && source.WORKER_PORT ? integerValue("WORKER_PORT", source.WORKER_PORT, 3000, 1, 65535) : integerValue("PORT", source.PORT, 3000, 1, 65535) };
  const database = { url: databaseUrl(source.DATABASE_URL) };
  const serviceToken = optional(source.AUTH_SERVICE_TOKEN);
  const permissions = servicePermissions(source.AUTH_SERVICE_PERMISSIONS);
  if (permissions.length && !serviceToken) throw new Error("AUTH_SERVICE_TOKEN is required when AUTH_SERVICE_PERMISSIONS is set");
  productionSecret("AUTH_SERVICE_TOKEN", serviceToken, production);
  const adminEmails = (source.AUTH_ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
  if (adminEmails.some((v) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))) throw new Error("AUTH_ADMIN_EMAILS must contain email addresses");
  const appId = optional(source.PRIVY_APP_ID);
  const appSecret = optional(source.PRIVY_APP_SECRET);
  if (Boolean(appId) !== Boolean(appSecret)) throw new Error("PRIVY_APP_ID and PRIVY_APP_SECRET must be set together");
  const verificationKey = optional(source.PRIVY_VERIFICATION_KEY)?.replace(/\\n/g, "\n");
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
  const egressKey = optional(source.HYPERLIQUID_EGRESS_KEY);
  if (source.HYPERLIQUID_EGRESS_KEY !== undefined && (!egressKey || !/^[A-Za-z0-9:._-]{1,128}$/.test(egressKey))) throw new Error('HYPERLIQUID_EGRESS_KEY must be a canonical shared egress identifier');
  // Every Hyperliquid info call goes through the shared quota, which refuses
  // to run without the alias: a deployment that forgot it would start, pass
  // its readiness check, and then fail every trader page, snapshot and
  // discovery read. It fails here instead (staging and production; local
  // development and tests may run without it, public reads then fail).
  if (production && !egressKey) throw new Error("HYPERLIQUID_EGRESS_KEY is required in staging and production (the same value on the api and the worker)");
  const hyperliquid = {
    /** All application processes sharing outbound capacity use this exact
     * alias. Missing configuration never grants unmetered actual execution. */
    egressKey,
    apiUrl: urlValue("HYPERLIQUID_API_URL", source.HYPERLIQUID_API_URL, "https://api.hyperliquid.xyz/info", ["http:", "https:"]),
    wsUrl: urlValue("HYPERLIQUID_WS_URL", source.HYPERLIQUID_WS_URL, "wss://api.hyperliquid.xyz/ws", ["ws:", "wss:"]),
    /** This process's share of the per-IP REST limit. The api's and the
     * worker's must add up (with their bursts) to what one IP may spend:
     * both draw on the same meter, whose background lane holds 840
     * (HYPERLIQUID_BACKGROUND_REST_CAP). A worker beside an api that reads the
     * same environment (one .env on one machine) takes
     * HYPERLIQUID_WORKER_WEIGHT_*, as it takes WORKER_PORT; a deployment
     * sets each service's own HYPERLIQUID_WEIGHT_* instead. */
    budgetPerMin: isWorker && source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN !== undefined
      ? integerValue("HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WORKER_WEIGHT_BUDGET_PER_MIN, 360, 1, 1199)
      : integerValue("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN, 840, 1, 1199),
    burst: isWorker && source.HYPERLIQUID_WORKER_WEIGHT_BURST !== undefined
      ? integerValue("HYPERLIQUID_WORKER_WEIGHT_BURST", source.HYPERLIQUID_WORKER_WEIGHT_BURST, 100, 1, 1200)
      : integerValue("HYPERLIQUID_WEIGHT_BURST", source.HYPERLIQUID_WEIGHT_BURST, 200, 1, 1200),
    /** Share of the budget rate the page reserve keeps refilling at while
     * page work is over its share of the minute: the floor pages always get. */
    pageReserveShare: decimalValue("HYPERLIQUID_PAGE_RESERVE_SHARE", source.HYPERLIQUID_PAGE_RESERVE_SHARE, 0.25, 0.05, 0.9),
    /** A new process sends at a reduced rate, from empty buckets, for this
     * long: during a redeploy the instance it replaces is still spending
     * the same IP limit. 0: full rate and a full burst at once. */
    startupPaceSeconds: integerValue("HYPERLIQUID_STARTUP_PACE_SECONDS", source.HYPERLIQUID_STARTUP_PACE_SECONDS, 60, 0, 600),
    wallet: walletNetwork(source),
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
  return { app, database, limits, http, auth: { serviceToken, permissions, adminEmails, appId, appSecret, verificationKey }, telegram, hyperliquid, alert, stream, copy: copyTrading(source, hyperliquid.wallet.network, egressKey), archive: archive(source) };
}
export type RuntimeConfig = ReturnType<typeof validateEnvironment>;
