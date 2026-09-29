import type { AppConfig } from "../src/config/app-config.js";
import { env, getIntEnv } from "../src/config/env.js";

/** Legacy suites vary env flags within a case. Explicitly injected mutable test
 * double; production always uses AppConfig's frozen validated snapshot. */
export function testConfig(): AppConfig {
  return { get value() { return {
    app: { nodeEnv: process.env.NODE_ENV ?? "test", port: 3000 },
    database: { url: "postgres://unused@localhost/unused_test" },
    auth: { serviceToken: env.serviceToken(), permissions: env.servicePermissions(), adminEmails: env.adminEmails(), appId: env.privyAppId(), appSecret: env.privyAppSecret(), verificationKey: env.privyVerificationKey() },
    telegram: { botToken: env.telegramBotToken(), botUsername: env.telegramBotUsername(), systemChatId: env.telegramSystemChatId(), dryRun: env.telegramDryRun(), polling: env.telegramBotPolling(), linkBaseUrl: env.telegramLinkBaseUrl() },
    hyperliquid: { apiUrl: env.hyperliquidApiUrl(), wsUrl: env.hyperliquidWsUrl(), budgetPerMin: env.hyperliquidWeightBudgetPerMin(), burst: getIntEnv("HYPERLIQUID_WEIGHT_BURST", 200, 1, 1200) },
    alert: { maxActionAgeSeconds: env.alertMaxActionAgeSeconds() },
  }; } };
}
