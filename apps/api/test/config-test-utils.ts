import type { AppConfig } from "../src/config/app-config.js";
import { env, getIntEnv } from "../src/config/env.js";
import { tuningConfig } from "../src/config/runtime-config.js";

/** Legacy suites vary env flags within a case. Explicitly injected mutable test
 * double; production always uses AppConfig's frozen validated snapshot. */
export function testConfig(): AppConfig {
  return { get value() { return {
    stream: { maxPerIp: env.streamMaxPerIp(), maxTotal: env.streamMaxTotal(), trustedProxyHops: env.streamTrustedProxyHops() },
    http: { corsOrigins: [] },
    limits: { ingressPerMinute: 100000, readPerMinute: 100000, writePerMinute: 100000, expensivePerMinute: 100000, favoritesPerUser: getIntEnv("MAX_FAVORITES_PER_USER", 100, 1, 10000) },
    app: { isWorker: process.env.IS_WORKER === "true", workerUrl: process.env.WORKER_URL, trustedProxyCidrs: [], nodeEnv: process.env.NODE_ENV ?? "test", port: 3000 },
    database: { url: "postgres://unused@localhost/unused_test" },
    auth: { serviceToken: env.serviceToken(), permissions: env.servicePermissions(), adminEmails: env.adminEmails(), appId: env.privyAppId(), appSecret: env.privyAppSecret(), verificationKey: env.privyVerificationKey() },
    telegram: { botToken: env.telegramBotToken(), botUsername: env.telegramBotUsername(), systemChatId: env.telegramSystemChatId(), dryRun: env.telegramDryRun(), polling: env.telegramBotPolling(), linkBaseUrl: env.telegramLinkBaseUrl() },
    hyperliquid: { egressKey: process.env.HYPERLIQUID_EGRESS_KEY, apiUrl: env.hyperliquidApiUrl(), wsUrl: env.hyperliquidWsUrl(), budgetPerMin: env.hyperliquidWeightBudgetPerMin(), burst: getIntEnv("HYPERLIQUID_WEIGHT_BURST", 200, 1, 1200),
      pageReserveShare: Number(process.env.HYPERLIQUID_PAGE_RESERVE_SHARE ?? 0.25),
      startupPaceSeconds: getIntEnv("HYPERLIQUID_STARTUP_PACE_SECONDS", 0, 0, 600),
      wallet: { network: "testnet" as const, infoUrl: "https://api.hyperliquid-testnet.xyz/info", arbitrumRpcUrl: "https://sepolia-rollup.arbitrum.io/rpc" } },
    alert: { maxActionAgeSeconds: env.alertMaxActionAgeSeconds() },
    archive: { enabled: false, bucket: "hl-mainnet-node-data", region: "ap-northeast-1", localDir: undefined as string | undefined, start: Date.UTC(2025, 4, 25),
      credentials: undefined as { accessKeyId: string; secretAccessKey: string; sessionToken: string | undefined } | undefined,
      maxDailyUsd: 2, usdPerGb: 0.114, maxBytesPerMinute: 268_435_456, settleMinutes: 20, maxFillsPerAddressHour: 0, backfill: true, backfillDays: 3650, passIntervalHours: 0, trust: "regular" as "none" | "regular" | "all" },
    copy: { mode: (process.env.COPY_TRADING_MODE === "disabled" ? "disabled" : "paper") as "paper" | "disabled", workerIntervalMs: 2000 },
    // Read on every access, so a case can set DISCOVERY_* / RETENTION_* for itself.
    tuning: tuningConfig(process.env),
  }; } };
}
