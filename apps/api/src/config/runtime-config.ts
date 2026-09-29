import { createPublicKey } from "node:crypto";
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
  const app = { nodeEnv, port: integerValue("PORT", source.PORT, 3000, 1, 65535) };
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
  const hyperliquid = {
    apiUrl: urlValue("HYPERLIQUID_API_URL", source.HYPERLIQUID_API_URL, "https://api.hyperliquid.xyz/info", ["http:", "https:"]),
    wsUrl: urlValue("HYPERLIQUID_WS_URL", source.HYPERLIQUID_WS_URL, "wss://api.hyperliquid.xyz/ws", ["ws:", "wss:"]),
    budgetPerMin: integerValue("HYPERLIQUID_WEIGHT_BUDGET_PER_MIN", source.HYPERLIQUID_WEIGHT_BUDGET_PER_MIN, 840, 1, 1199),
    burst: integerValue("HYPERLIQUID_WEIGHT_BURST", source.HYPERLIQUID_WEIGHT_BURST, 200, 1, 1200),
  };
  const alert = { maxActionAgeSeconds: integerValue("ALERT_MAX_ACTION_AGE_SECONDS", source.ALERT_MAX_ACTION_AGE_SECONDS, 120, 1, 86400) };
  const stream = {
    maxPerIp: integerValue("STREAM_MAX_PER_IP", source.STREAM_MAX_PER_IP, 8, 1, 1000),
    maxTotal: integerValue("STREAM_MAX_TOTAL", source.STREAM_MAX_TOTAL, 500, 1, 100_000),
    trustedProxyHops: integerValue("STREAM_TRUSTED_PROXY_HOPS", source.STREAM_TRUSTED_PROXY_HOPS, 0, 0, 10),
  };
  if (stream.maxPerIp > stream.maxTotal) throw new Error("STREAM_MAX_PER_IP must not exceed STREAM_MAX_TOTAL");
  return { app, database, auth: { serviceToken, permissions, adminEmails, appId, appSecret, verificationKey }, telegram, hyperliquid, alert, stream };
}
export type RuntimeConfig = ReturnType<typeof validateEnvironment>;
