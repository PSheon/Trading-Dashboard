/**
 * Single-password web session (PRD §8 安全). Still no account system (§1
 * non-goal "不做登入系統（單一 env token）") — one server-only password
 * (`WEB_PASSWORD`) guards the dashboard, and the api's bearer token never
 * leaves the server (see app/api/hl/[...path]/route.ts).
 *
 * Server-only: imported by proxy.ts, route handlers and server actions. It
 * uses node:crypto, so importing it from a client component fails the build.
 *
 * Cookie value: `v1.<expiresAtMs>.<hmac>` where hmac = HMAC-SHA256 over
 * `v1.<expiresAtMs>`. The signing key is derived from WEB_SESSION_SECRET *and*
 * WEB_PASSWORD, so rotating either one logs every browser out.
 *
 * Fail closed: when either env var is missing (or the secret is too short),
 * `authConfig()` returns null, nobody can log in and no cookie verifies.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "hl_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const LOGIN_PATH = "/login";

const MIN_SECRET_LENGTH = 32;
const VERSION = "v1";

interface AuthConfig {
  password: string;
  signingKey: Buffer;
}

export function authConfig(): AuthConfig | null {
  const password = process.env.WEB_PASSWORD;
  const secret = process.env.WEB_SESSION_SECRET;
  if (!password || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  const signingKey = createHash("sha256")
    .update(secret)
    .update("\0")
    .update(password)
    .digest();
  return { password, signingKey };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time password check. Both sides are hashed to 32 bytes first, so
 * inputs of different lengths neither throw nor return early. */
export function passwordMatches(candidate: string, config: AuthConfig) {
  return timingSafeEqual(sha256(candidate), sha256(config.password));
}

function sign(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function createSessionValue(config: AuthConfig, now = Date.now()) {
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${VERSION}.${expiresAt}`;
  return `${payload}.${sign(payload, config.signingKey)}`;
}

export function isValidSession(
  value: string | undefined,
  now = Date.now(),
): boolean {
  const config = authConfig();
  if (!config || !value) return false;

  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [version, expires, mac] = parts;
  if (version !== VERSION || !/^\d{1,16}$/.test(expires)) return false;

  const expected = Buffer.from(sign(`${version}.${expires}`, config.signingKey));
  const given = Buffer.from(mac);
  if (given.length !== expected.length) return false;
  if (!timingSafeEqual(given, expected)) return false;

  return Number(expires) > now;
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}

/**
 * Only same-site, path-relative redirect targets are allowed after login.
 * Anything else (absolute URLs, protocol-relative `//host`, backslash tricks,
 * control characters) falls back to "/".
 */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) {
    return "/";
  }
  if (!next.startsWith("/") || next.startsWith("//")) return "/";
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return "/";

  // Belt and braces: resolve against a dummy origin and make sure it stays
  // there.
  const base = "http://same-site.invalid";
  let url: URL;
  try {
    url = new URL(next, base);
  } catch {
    return "/";
  }
  if (url.origin !== base) return "/";
  if (url.pathname === LOGIN_PATH) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
