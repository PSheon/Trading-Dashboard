/** Server side only: the caller's address, for apps/api's per-client limits. */
import { isIP } from "node:net";

/**
 * The browser's address as the platform in front of this server reported
 * it, or undefined when it reported none. Which header that is depends on
 * the host, so it is configuration (`CLIENT_IP_HEADER`, server-side):
 *
 * - unset: the last `X-Forwarded-For` entry, the one the nearest proxy
 *   appended (Vercel; any proxy that appends). Entries further left are
 *   whatever the client sent.
 * - `x-real-ip` (Railway: its edge sets that header to the client's
 *   address; its documented header list has no X-Forwarded-For), or any
 *   other single-address header the edge overwrites.
 *
 * The value is only as good as the edge: it must set the header itself on
 * every request. apps/api trusts what this server forwards only when this
 * server's address is in its API_TRUSTED_PROXY_CIDRS.
 */
export function clientAddress(headers: Headers, header = process.env.CLIENT_IP_HEADER): string | undefined {
  const name = header?.trim().toLowerCase();
  const raw = headers.get(name || "x-forwarded-for") ?? "";
  const entry = raw.split(",").map((v) => v.trim()).filter(Boolean).at(-1);
  return entry && isIP(entry) ? entry : undefined;
}

/** The bucket an address counts against: IPv4 per address, IPv6 per /64
 * (one subscriber is handed a whole /64), as apps/api's `clientKey` does. */
export function clientBucket(address: string | undefined): string {
  if (!address) return "unknown";
  if (isIP(address) !== 6) return address;
  const [head, tail] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

/** Share and link-preview images one client may ask for per minute. Each
 * uncached one costs four api reads (a profile, a chart, two analytics). */
export const IMAGES_PER_MINUTE = 30;
/** Coin icons one client may ask this server for per minute. A page shows
 * dozens (cached by the browser a day); only an uncached known market costs
 * an upstream request. */
export const ICONS_PER_MINUTE = 300;
const MAX_CLIENTS = 10_000;
const windows = new Map<string, { expires: number; count: number }>();

/**
 * In-process window for the image routes, which call apps/api from this
 * server on behalf of whoever asks. Returns 0 when the request may go on,
 * else the seconds until it may. A full table (after dropping expired
 * entries) puts new clients in one shared bucket rather than refusing them.
 */
export function imageRetryAfter(address: string | undefined, now = Date.now(), limit = IMAGES_PER_MINUTE): number {
  return windowRetryAfter("image", address, now, limit);
}

/** The same per-client window for the coin-icon route (its own count). */
export function iconRetryAfter(address: string | undefined, now = Date.now(), limit = ICONS_PER_MINUTE): number {
  return windowRetryAfter("icon", address, now, limit);
}

function windowRetryAfter(kind: string, address: string | undefined, now: number, limit: number): number {
  let key = `${kind}:${clientBucket(address)}`;
  let window = windows.get(key);
  if (!window && windows.size >= MAX_CLIENTS) {
    for (const [k, w] of windows) if (w.expires <= now) windows.delete(k);
    if (windows.size >= MAX_CLIENTS) {
      key = `${kind}:overflow`;
      window = windows.get(key);
    }
  }
  if (!window || window.expires <= now) {
    window = { expires: now + 60_000, count: 0 };
    windows.set(key, window);
  }
  if (window.count >= limit) return Math.max(1, Math.ceil((window.expires - now) / 1000));
  window.count += 1;
  return 0;
}

/** Forgets every window (tests). */
export function resetImageLimiter(): void {
  windows.clear();
}
