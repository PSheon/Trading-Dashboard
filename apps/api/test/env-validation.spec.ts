import { generateKeyPairSync } from "node:crypto";
import { validateEnvironment } from "../src/config/runtime-config.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, getBoolEnv, getIntEnv } from "./legacy-env.js";
import { AppConfig } from "../src/config/app-config.js";

afterEach(() => vi.unstubAllEnvs());

describe("unsafe runtime configuration", () => {
  it.each(["typo", "yes", "", "2"])("rejects ambiguous dry-run value %j", (value) => {
    vi.stubEnv("TELEGRAM_DRY_RUN", value);
    expect(() => getBoolEnv("TELEGRAM_DRY_RUN", true)).toThrow(/TELEGRAM_DRY_RUN/);
  });
  it.each(["840oops", "1.9", "", "NaN"])("rejects partial integer %j", (value) => {
    vi.stubEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", value);
    expect(() => getIntEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", 840)).toThrow(/HYPERLIQUID_WEIGHT_BUDGET_PER_MIN/);
  });
  it("does not construct a pool against a fallback database", () => {
    vi.stubEnv("DATABASE_URL", undefined);
    expect(() => new AppConfig(validateEnvironment())).toThrow(/DATABASE_URL/);
  });
});

const base = { DATABASE_URL: "postgres://audit:password@127.0.0.1:55439/audit_test" };
describe("startup environment", () => {
  it('retains an explicitly configured shared egress alias and never invents one', () => {
    expect(validateEnvironment(base).hyperliquid.egressKey).toBeUndefined();
    expect(validateEnvironment({ ...base, HYPERLIQUID_EGRESS_KEY: 'project-stage-shared-ip' }).hyperliquid.egressKey).toBe('project-stage-shared-ip');
  });
  it('refuses to start a deployment without the shared egress alias, instead of failing on first use', () => {
    for (const NODE_ENV of ['production', 'staging']) {
      expect(() => validateEnvironment({ ...base, NODE_ENV })).toThrow('HYPERLIQUID_EGRESS_KEY is required');
    }
    expect(validateEnvironment({ ...base, NODE_ENV: 'test' }).hyperliquid.egressKey).toBeUndefined();
  });
  it.each(['', ' ', 'different process', 'x'.repeat(129), 'hidden\u200b', 'host/path'])('rejects invalid shared egress alias %j', value => {
    expect(() => validateEnvironment({ ...base, HYPERLIQUID_EGRESS_KEY: value })).toThrow('HYPERLIQUID_EGRESS_KEY');
  });
  it("supports local public-only mode and safe dry-run defaults", () => {
    const result = validateEnvironment(base);
    expect(result.app.port).toBe(3000);
    expect(result.telegram.dryRun).toBe(true);
    expect(result.auth.permissions).toEqual([]);
  });
  it.each([
    ["API_CORS_ORIGINS", "*"], ["API_CORS_ORIGINS", "https://example.com/path"], ["API_CORS_ORIGINS", "https://user:pass@example.com"],
    ["API_READ_PER_MINUTE", "0"], ["MAX_FAVORITES_PER_USER", "1.5"],
    ["API_TRUSTED_PROXY_CIDRS", "true"], ["API_TRUSTED_PROXY_CIDRS", "0.0.0.0/0"], ["API_TRUSTED_PROXY_CIDRS", "::/129"],
    ["DATABASE_URL", ""], ["DATABASE_URL", "https://example.com/db"],
    ["PORT", "0"], ["PORT", "65536"], ["PORT", "3000oops"],
    ["NODE_ENV", "prodution"], ["HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "0"],
    ["HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "-1"], ["HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", "1200"],
    ["HYPERLIQUID_WEIGHT_BURST", "0"], ["ALERT_MAX_ACTION_AGE_SECONDS", "-1"],
    ["STREAM_MAX_PER_IP", "0"], ["STREAM_MAX_TOTAL", "5x"], ["STREAM_TRUSTED_PROXY_HOPS", "11"],
    ["STREAM_MAX_PER_IP", "600"],
    ["TELEGRAM_DRY_RUN", "typo"], ["TELEGRAM_BOT_POLLING", "yes"],
    ["HYPERLIQUID_API_URL", "file:///tmp/info"], ["HYPERLIQUID_WS_URL", "https://example.com"],
    ["TELEGRAM_LINK_BASE_URL", "https://user:secret@example.com"],
    ["AUTH_SERVICE_PERMISSIONS", "*"], ["AUTH_ADMIN_EMAILS", "not-an-email"],
  ])("rejects invalid %s without echoing its value", (key, value) => {
    expect(() => validateEnvironment({ ...base, [key]: value })).toThrow(key);
  });
  it("copy trading is paper by default; testnet needs its signing prerequisites", () => {
    expect(validateEnvironment(base).copy).toEqual({ mode: "paper", workerIntervalMs: 2000 });
    expect(validateEnvironment({ ...base, COPY_TRADING_MODE: "disabled" }).copy.mode).toBe("disabled");
    expect(() => validateEnvironment({ ...base, COPY_TRADING_MODE: "live" })).toThrow("HYPERLIQUID_NETWORK=mainnet");
    expect(() => validateEnvironment({ ...base, COPY_TRADING_MODE: "yolo" })).toThrow("paper, testnet, live or disabled");
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const testnet = { ...base, COPY_TRADING_MODE: "testnet", HYPERLIQUID_NETWORK: "testnet", HYPERLIQUID_EGRESS_KEY: "shared-egress",
      PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret", PRIVY_AGENT_AUTHORIZATION_KEY: key, PRIVY_AGENT_WORKER_QUORUM_ID: "worker" };
    expect(validateEnvironment(testnet).copy).toMatchObject({ mode: "testnet", live: { maxSourceDeviationBps: 500, slippageBps: 30, intervalMs: 3000, weightPerMin: 300 } });
    expect(validateEnvironment({ ...testnet, COPY_TESTNET_MAX_PRICE_DEVIATION_BPS: "1000" }).copy.live?.maxSourceDeviationBps).toBe(1000);
    expect(() => validateEnvironment({ ...testnet, HYPERLIQUID_NETWORK: "mainnet" })).toThrow("HYPERLIQUID_NETWORK=testnet");
    expect(() => validateEnvironment({ ...testnet, HYPERLIQUID_EGRESS_KEY: undefined })).toThrow("HYPERLIQUID_EGRESS_KEY");
    expect(() => validateEnvironment({ ...testnet, PRIVY_AGENT_AUTHORIZATION_KEY: undefined, PRIVY_AGENT_WORKER_QUORUM_ID: undefined })).toThrow("PRIVY_AGENT_AUTHORIZATION_KEY");
    expect(() => validateEnvironment({ ...testnet, COPY_TESTNET_MAX_PRICE_DEVIATION_BPS: "10001" })).toThrow("COPY_TESTNET_MAX_PRICE_DEVIATION_BPS");
    // Once an order reads ~385, the testnet rate may go up to 700/min (burst 500).
    expect(validateEnvironment({ ...testnet, COPY_LIVE_WEIGHT_PER_MIN: "700" }).copy.live?.weightPerMin).toBe(700);
    expect(() => validateEnvironment({ ...testnet, COPY_LIVE_WEIGHT_PER_MIN: "701" })).toThrow("COPY_LIVE_WEIGHT_PER_MIN");
    // The realtime copy source is off unless named, per leader or for all.
    expect(validateEnvironment(testnet).copy.live?.fastSource).toBeUndefined();
    expect(validateEnvironment({ ...testnet, COPY_LIVE_FAST_SOURCE: " " }).copy.live?.fastSource).toBeUndefined();
    expect(validateEnvironment({ ...testnet, COPY_LIVE_FAST_SOURCE: `0x${"E7".repeat(20)}, 0x${"aa".repeat(20)}` }).copy.live?.fastSource)
      .toEqual({ leaders: new Set([`0x${"e7".repeat(20)}`, `0x${"aa".repeat(20)}`]), graceMs: 2000 });
    expect(validateEnvironment({ ...testnet, COPY_LIVE_FAST_SOURCE: "all", COPY_LIVE_FAST_SOURCE_GRACE_MS: "3000" }).copy.live?.fastSource).toEqual({ leaders: "all", graceMs: 3000 });
    expect(() => validateEnvironment({ ...testnet, COPY_LIVE_FAST_SOURCE: "0xnope" })).toThrow("COPY_LIVE_FAST_SOURCE");
  });

  describe("a live deployment (HYPERLIQUID_NETWORK=mainnet, COPY_TRADING_MODE=live)", () => {
    const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
    const live = { ...base, COPY_TRADING_MODE: "live", HYPERLIQUID_NETWORK: "mainnet", HYPERLIQUID_EGRESS_KEY: "shared-egress",
      PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret", PRIVY_AGENT_AUTHORIZATION_KEY: key, PRIVY_AGENT_WORKER_QUORUM_ID: "worker",
      COPY_LIVE_ALLOWED_PRIVY_USER_IDS: "did:privy:paul, did:privy:other" };
    it("boots with the allowlist, on mainnet only, with the default caps and no builder fee", () => {
      const copy = validateEnvironment(live).copy;
      expect(copy).toMatchObject({ mode: "live", live: { network: "mainnet", builderFee: false, testnetSourceIntervalMs: 60_000,
        caps: { maxStrategiesPerUser: 2, fixedPerTradeUsd: { min: 12, max: 15 }, maxLeverage: 3 } } });
      expect(copy.live?.allowedPrivyUserIds).toEqual(new Set(["did:privy:paul", "did:privy:other"]));
      expect(copy.live?.caps.maxAllocationUsd).toBeUndefined();
      expect(validateEnvironment({ ...live, COPY_LIVE_MAX_ALLOCATION_USD: "50", COPY_LIVE_MAX_STRATEGIES_PER_USER: "1", COPY_LIVE_MAX_LEVERAGE: "2",
        COPY_LIVE_FIXED_PER_TRADE_MIN_USD: "13", COPY_LIVE_FIXED_PER_TRADE_MAX_USD: "14" }).copy.live?.caps)
        .toEqual({ maxStrategiesPerUser: 1, maxAllocationUsd: 50, maxLeverage: 2, fixedPerTradeUsd: { min: 13, max: 14 } });
    });
    it("refuses to boot without the allowlist, on testnet, or with bad caps", () => {
      expect(() => validateEnvironment({ ...live, COPY_LIVE_ALLOWED_PRIVY_USER_IDS: undefined })).toThrow("COPY_LIVE_ALLOWED_PRIVY_USER_IDS");
      expect(() => validateEnvironment({ ...live, COPY_LIVE_ALLOWED_PRIVY_USER_IDS: " , " })).toThrow("COPY_LIVE_ALLOWED_PRIVY_USER_IDS");
      expect(() => validateEnvironment({ ...live, COPY_LIVE_ALLOWED_PRIVY_USER_IDS: "paul@example.com" })).toThrow("COPY_LIVE_ALLOWED_PRIVY_USER_IDS");
      expect(() => validateEnvironment({ ...live, HYPERLIQUID_NETWORK: "testnet" })).toThrow("HYPERLIQUID_NETWORK=mainnet");
      expect(() => validateEnvironment({ ...live, COPY_TRADING_MODE: "testnet" })).toThrow("HYPERLIQUID_NETWORK=testnet");
      expect(() => validateEnvironment({ ...live, PRIVY_AGENT_AUTHORIZATION_KEY: undefined, PRIVY_AGENT_WORKER_QUORUM_ID: undefined })).toThrow("PRIVY_AGENT_AUTHORIZATION_KEY");
      // At least 11 USDC a trade (the exchange's 10 USDC minimum with rounding room), min ≤ max.
      expect(() => validateEnvironment({ ...live, COPY_LIVE_FIXED_PER_TRADE_MIN_USD: "10" })).toThrow("COPY_LIVE_FIXED_PER_TRADE_MIN_USD");
      expect(() => validateEnvironment({ ...live, COPY_LIVE_FIXED_PER_TRADE_MIN_USD: "16" })).toThrow("must not exceed");
      expect(() => validateEnvironment({ ...live, COPY_LIVE_MAX_STRATEGIES_PER_USER: "0" })).toThrow("COPY_LIVE_MAX_STRATEGIES_PER_USER");
    });
    it("leaves a testnet deployment's caps as they were unless set, and its testnet source interval configurable", () => {
      const testnet = { ...live, COPY_TRADING_MODE: "testnet", HYPERLIQUID_NETWORK: "testnet", COPY_LIVE_ALLOWED_PRIVY_USER_IDS: undefined };
      expect(validateEnvironment(testnet).copy.live).toMatchObject({ network: "testnet", builderFee: true, caps: { maxStrategiesPerUser: 2 } });
      expect(validateEnvironment(testnet).copy.live?.caps).toEqual({ maxStrategiesPerUser: 2 });
      expect(validateEnvironment(testnet).copy.live?.allowedPrivyUserIds).toBeUndefined();
      expect(validateEnvironment({ ...testnet, COPY_LIVE_TESTNET_SOURCE_INTERVAL_MS: "3000" }).copy.live?.testnetSourceIntervalMs).toBe(3000);
      expect(() => validateEnvironment({ ...testnet, COPY_LIVE_FIXED_PER_TRADE_MIN_USD: "12" })).toThrow("set together");
    });
  });

  it("requires a database explicitly", () => {
    expect(() => validateEnvironment({})).toThrow("DATABASE_URL");
  });
  it("does not leak database credentials in an error", () => {
    const secret = "never-print-this-password";
    try { validateEnvironment({ DATABASE_URL: `https://user:${secret}@host/db` }); }
    catch (error) { expect(String(error)).not.toContain(secret); return; }
    throw new Error("Expected validation failure");
  });
  it("requires Privy credentials as a pair and validates the optional public key", () => {
    expect(() => validateEnvironment({ ...base, PRIVY_APP_ID: "app" })).toThrow("PRIVY");
    expect(() => validateEnvironment({ ...base, PRIVY_APP_ID: "app", PRIVY_APP_SECRET: "secret", PRIVY_VERIFICATION_KEY: "not-a-key" })).toThrow("PRIVY_VERIFICATION_KEY");
  });
  it("requires credentials for real Telegram sending and a username for linking", () => {
    expect(() => validateEnvironment({ ...base, TELEGRAM_DRY_RUN: "false" })).toThrow("TELEGRAM_BOT_TOKEN");
    expect(() => validateEnvironment({ ...base, TELEGRAM_BOT_TOKEN: "test-token" })).toThrow("TELEGRAM_BOT_USERNAME");
  });
  it("rejects production placeholder tokens and scopes without a token", () => {
    expect(() => validateEnvironment({ ...base, NODE_ENV: "production", AUTH_SERVICE_TOKEN: "change-me-to-a-long-random-string" })).toThrow("AUTH_SERVICE_TOKEN");
    expect(() => validateEnvironment({ ...base, NODE_ENV: "staging", AUTH_SERVICE_TOKEN: "short" })).toThrow("AUTH_SERVICE_TOKEN");
    expect(() => validateEnvironment({ ...base, AUTH_SERVICE_PERMISSIONS: "users.read" })).toThrow("AUTH_SERVICE_TOKEN");
  });
  it("uses the same normalized optional values at startup and during authentication", () => {
    const input = { ...base, AUTH_SERVICE_TOKEN: "  scoped-token  ", PRIVY_APP_ID: "  ", PRIVY_APP_SECRET: "  ", TELEGRAM_BOT_TOKEN: "  " };
    for (const [key, value] of Object.entries(input)) vi.stubEnv(key, value);
    const config = validateEnvironment(input);
    expect(config.auth.serviceToken).toBe("scoped-token");
    expect(env.serviceToken()).toBe(config.auth.serviceToken);
    expect(env.privyAppId()).toBeUndefined();
    expect(env.privyAppSecret()).toBeUndefined();
    expect(env.telegramBotToken()).toBeUndefined();
  });

  it("never lets the service token make admins or change site settings", () => {
    const token = { AUTH_SERVICE_TOKEN: "service-token-0123456789abcdef0123456789" };
    expect(() => validateEnvironment({ ...base, ...token, AUTH_SERVICE_PERMISSIONS: "admin.access,users.manage" })).toThrow("users.manage");
    expect(() => validateEnvironment({ ...base, ...token, AUTH_SERVICE_PERMISSIONS: "settings.write" })).toThrow("settings.write");
    expect(validateEnvironment({ ...base, ...token, AUTH_SERVICE_PERMISSIONS: "admin.access,users.read" }).auth.permissions).toEqual(["admin.access", "users.read"]);
  });

  it("accepts explicit service permissions without implicitly granting all permissions", () => {
    const result = validateEnvironment({ ...base, AUTH_SERVICE_TOKEN: "test-token", AUTH_SERVICE_PERMISSIONS: "users.read, users.read,settings.read" });
    expect(result.auth.permissions).toEqual(["users.read", "settings.read"]);
  });
});
