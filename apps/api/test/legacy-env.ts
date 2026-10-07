import { booleanValue, databaseUrl, integerValue, servicePermissions } from "../src/config/parse-env.js";

/** Test-only (no production importer; moved out of src/config). Legacy readers retained for parser regression tests and explicit test doubles.
 * Production providers must use injected AppConfig, never these dynamic readers. */
export function getEnv(key: string): string | undefined {
  return process.env[key]?.trim() || undefined;
}

export function requireEnv(key: string): string {
  const value = getEnv(key);
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function getBoolEnv(key: string, defaultValue = false): boolean {
  return booleanValue(key, process.env[key], defaultValue);
}

export function getIntEnv(key: string, defaultValue: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  return integerValue(key, process.env[key], defaultValue, min, max);
}

export const env = {
  databaseUrl: () => databaseUrl(getEnv("DATABASE_URL")),
  /** Server-to-server token; a request bearing it is the service caller
   * (requires explicit permissions). Never sent to a browser. */
  serviceToken: () => getEnv("AUTH_SERVICE_TOKEN") || undefined,
  servicePermissions: () => servicePermissions(getEnv("AUTH_SERVICE_PERMISSIONS")),
  /** Privy sign-in. Both unset → Privy tokens are rejected (fail closed). */
  privyAppId: () => getEnv("PRIVY_APP_ID") || undefined,
  privyAppSecret: () => getEnv("PRIVY_APP_SECRET") || undefined,
  /** Optional: the app's verification key (PEM/SPKI) from the Privy
   * dashboard; verifies tokens locally instead of fetching the JWKS. */
  privyVerificationKey: () => getEnv("PRIVY_VERIFICATION_KEY")?.replace(/\\n/g, "\n") || undefined,
  /** Comma-separated emails bootstrapped as admin only at account creation. */
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
  /** Default true: alerts and system messages are logged instead of sent.
   * The bot's own replies in a chat (linking, /stop) are always sent. */
  telegramDryRun: () => getBoolEnv("TELEGRAM_DRY_RUN", true),
  /** Default true: receive bot updates (/start, /stop) by long polling
   * `getUpdates`. Only one process may poll a token at a time, so turn it
   * off everywhere but one (e.g. local dev next to a deployed api). */
  telegramBotPolling: () => getBoolEnv("TELEGRAM_BOT_POLLING", true),
  /** Site origin for links inside Telegram messages, no trailing slash. */
  telegramLinkBaseUrl: () => getEnv("TELEGRAM_LINK_BASE_URL") ?? "https://app.orbie.fun",
  hyperliquidApiUrl: () =>
    getEnv("HYPERLIQUID_API_URL") ?? "https://api.hyperliquid.xyz/info",
  hyperliquidWsUrl: () =>
    getEnv("HYPERLIQUID_WS_URL") ?? "wss://api.hyperliquid.xyz/ws",

  /** W6: REST weight per minute, default 70% of Hyperliquid's 1200 (§8). */
  hyperliquidWeightBudgetPerMin: () =>
    getIntEnv("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", 840, 1, 1199),
  /** Actions older than this are stored but never alerted on (catch-up
   * sweeps find fills late; a stale alert would read as news). */
  alertMaxActionAgeSeconds: () => getIntEnv("ALERT_MAX_ACTION_AGE_SECONDS", 120, 1, 86400),

  /** GET /actions/stream: open streams allowed per client address. */
  streamMaxPerIp: () => getIntEnv("STREAM_MAX_PER_IP", STREAM_DEFAULTS.maxPerIp, 1, 1000),
  /** GET /actions/stream: open streams allowed in this process. */
  streamMaxTotal: () => getIntEnv("STREAM_MAX_TOTAL", STREAM_DEFAULTS.maxTotal, 1, 100_000),
  /** Proxies in front of the api whose X-Forwarded-For entries are trusted
   * to name the client (0: the socket's peer address). */
  streamTrustedProxyHops: () => getIntEnv("STREAM_TRUSTED_PROXY_HOPS", STREAM_DEFAULTS.trustedProxyHops, 0, 10),
};

export const STREAM_DEFAULTS = { maxPerIp: 8, maxTotal: 500, trustedProxyHops: 0 } as const;
