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

export function getIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const env = {
  databaseUrl: () => getEnv("DATABASE_URL"),
  apiAuthToken: () => getEnv("API_AUTH_TOKEN"),
  telegramBotToken: () => getEnv("TELEGRAM_BOT_TOKEN"),
  telegramChatIdRealtime: () => getEnv("TELEGRAM_CHAT_ID_REALTIME"),
  telegramChatIdGroup: () => getEnv("TELEGRAM_CHAT_ID_GROUP"),
  dryRun: () => getBoolEnv("DRY_RUN", true),
  /** N1: base URL for the "dashboard 詳情連結" in a notification message —
   * e.g. `https://dashboard.example.com`, no trailing slash. */
  dashboardBaseUrl: () => getEnv("DASHBOARD_BASE_URL") ?? "http://localhost:3001",
  hyperliquidApiUrl: () =>
    getEnv("HYPERLIQUID_API_URL") ?? "https://api.hyperliquid.xyz/info",
  hyperliquidWsUrl: () =>
    getEnv("HYPERLIQUID_WS_URL") ?? "wss://api.hyperliquid.xyz/ws",

  /** W6: REST weight per minute, default 70% of Hyperliquid's 1200 (§8). */
  hyperliquidWeightBudgetPerMin: () =>
    getIntEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", 840),
  /** Actions older than this are stored but never alerted on (catch-up
   * sweeps find fills late; a stale alert would read as news). */
  alertMaxActionAgeSeconds: () => getIntEnv("ALERT_MAX_ACTION_AGE_SECONDS", 600),
};
