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
  /** Server-to-server token; a request bearing it is the service caller
   * (counts as admin). Never sent to a browser. */
  serviceToken: () => getEnv("AUTH_SERVICE_TOKEN"),
  /** Privy sign-in. Both unset → Privy tokens are rejected (fail closed). */
  privyAppId: () => getEnv("PRIVY_APP_ID") || undefined,
  privyAppSecret: () => getEnv("PRIVY_APP_SECRET") || undefined,
  /** Optional: the app's verification key (PEM/SPKI) from the Privy
   * dashboard; verifies tokens locally instead of fetching the JWKS. */
  privyVerificationKey: () => getEnv("PRIVY_VERIFICATION_KEY")?.replace(/\\n/g, "\n") || undefined,
  /** Comma-separated emails promoted to admin when they sign in. */
  adminEmails: (): string[] =>
    (getEnv("AUTH_ADMIN_EMAILS") ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  telegramBotToken: () => getEnv("TELEGRAM_BOT_TOKEN"),
  /** The official bot's username without "@", for t.me links. */
  telegramBotUsername: () => getEnv("TELEGRAM_BOT_USERNAME") || undefined,
  /** Chat for system messages (feed outages etc.), not user alerts. */
  telegramSystemChatId: () => getEnv("TELEGRAM_SYSTEM_CHAT_ID") || undefined,
  /** Default true: messages are logged instead of sent. */
  telegramDryRun: () => getBoolEnv("TELEGRAM_DRY_RUN", true),
  /** Site origin for links inside Telegram messages, no trailing slash. */
  telegramLinkBaseUrl: () => getEnv("TELEGRAM_LINK_BASE_URL") ?? "https://app.orbie.fun",
  hyperliquidApiUrl: () =>
    getEnv("HYPERLIQUID_API_URL") ?? "https://api.hyperliquid.xyz/info",
  hyperliquidWsUrl: () =>
    getEnv("HYPERLIQUID_WS_URL") ?? "wss://api.hyperliquid.xyz/ws",

  /** W6: REST weight per minute, default 70% of Hyperliquid's 1200 (§8). */
  hyperliquidWeightBudgetPerMin: () =>
    getIntEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", 840),
  /** Actions older than this are stored but never alerted on (catch-up
   * sweeps find fills late; a stale alert would read as news). */
  alertMaxActionAgeSeconds: () => getIntEnv("ALERT_MAX_ACTION_AGE_SECONDS", 120),
};
