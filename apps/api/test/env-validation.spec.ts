import { validateEnvironment } from "../src/config/runtime-config.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env, getBoolEnv, getIntEnv } from "../src/config/env.js";
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
  it("copy trading is paper by default; testnet and live are refused in this build", () => {
    expect(validateEnvironment(base).copy).toEqual({ mode: "paper", workerIntervalMs: 2000 });
    expect(validateEnvironment({ ...base, COPY_TRADING_MODE: "disabled" }).copy.mode).toBe("disabled");
    expect(() => validateEnvironment({ ...base, COPY_TRADING_MODE: "live" })).toThrow("not available in this build");
    expect(() => validateEnvironment({ ...base, COPY_TRADING_MODE: "testnet" })).toThrow("not available in this build");
    expect(() => validateEnvironment({ ...base, COPY_TRADING_MODE: "yolo" })).toThrow("paper or disabled");
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

  it("accepts explicit service permissions without implicitly granting all permissions", () => {
    const result = validateEnvironment({ ...base, AUTH_SERVICE_TOKEN: "test-token", AUTH_SERVICE_PERMISSIONS: "users.read, users.read,settings.read" });
    expect(result.auth.permissions).toEqual(["users.read", "settings.read"]);
  });
});
