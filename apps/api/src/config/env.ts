/**
 * Minimal env access helpers. No framework config library is introduced
 * for M1 — just typed getters so every module reads env the same way.
 * See root `.env.example` for the full list of variables this project needs.
 */

export function getEnv(key: string): string | undefined {
  return process.env[key];
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function getBoolEnv(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  return raw.toLowerCase() === "true" || raw === "1";
}

export const env = {
  databaseUrl: () => getEnv("DATABASE_URL"),
  apiAuthToken: () => getEnv("API_AUTH_TOKEN"),
  telegramBotToken: () => getEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatIdRealtime: () => getEnv("TELEGRAM_CHAT_ID_REALTIME"),
  telegramChatIdGroup: () => getEnv("TELEGRAM_CHAT_ID_GROUP"),
  dryRun: () => getBoolEnv("DRY_RUN", true),
  hyperliquidApiUrl: () =>
    getEnv("HYPERLIQUID_API_URL") ?? "https://api.hyperliquid.xyz/info",
  hyperliquidWsUrl: () =>
    getEnv("HYPERLIQUID_WS_URL") ?? "wss://api.hyperliquid.xyz/ws",
};
