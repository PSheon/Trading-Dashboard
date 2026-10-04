import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

/** Largest avatar kept (𝕏's 400×400 JPEGs are 10–60 KB). */
export const AVATAR_MAX_BYTES = 512 * 1024;
/** A cached avatar is fetched again after a week. */
export const AVATAR_REFRESH_MS = 7 * 24 * 3_600_000;
/** Browsers and CDNs keep a versioned avatar URL this long (the version
 * changes whenever the bytes do). */
export const AVATAR_MAX_AGE_S = 30 * 24 * 3_600;

export type AvatarImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Hosts whose images are never fetched: CopyDog's own CDN and API (Paul's
 * rule: never take another site's copies). */
const BLOCKED_HOSTS = /(?:^|\.)copydog\.xyz$/i;

/**
 * What a KOL's avatar is fetched from: the admin's explicit https URL, else
 * "x:<handle>" (the 𝕏 profile picture), else null (no avatar; the web draws
 * its generated one). An explicit URL on a blocked or private host is
 * ignored in favour of the handle.
 */
export function avatarSource(kol: { avatarUrl: string | null; xHandle: string | null }): string | null {
  if (kol.avatarUrl && allowedImageUrl(kol.avatarUrl)) return kol.avatarUrl;
  return kol.xHandle ? `x:${kol.xHandle}` : null;
}

/** https on a public host name, not CopyDog's and not an IP literal or
 * localhost (the fetch runs server-side). */
export function allowedImageUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  if (BLOCKED_HOSTS.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  // IPv4 / IPv6 literals: only names, so private ranges can't be targeted.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[")) return false;
  return host.includes(".");
}

/**
 * Whether a resolved address is on the public internet. The avatar fetch runs
 * inside the deployment's private network, so loopback, private, link-local,
 * CGNAT, multicast and reserved ranges are refused (IPv4, IPv6 and
 * IPv4-mapped IPv6).
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  const v4 = mapped ? mapped[1]! : /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip : null;
  if (v4) {
    const [a, b] = v4.split(".").map(Number) as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 169 && b === 254) return false; // link-local, cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (!ip.includes(":")) return false;
  if (ip === "::" || ip === "::1") return false;
  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8,
  // IPv4-compatible and NAT64 forms that embed an address, 6to4 2002::/16
  // and Teredo 2001:0::/32 (both carry an IPv4 address a relay may reach).
  if (/^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("::") || ip.startsWith("64:ff9b:")) return false;
  if (ip.startsWith("2002:") || /^2001:0{0,4}:/.test(ip)) return false;
  return true;
}

/**
 * GET `url` connecting only to `address`, the one already vetted
 * (`isPublicAddress`): the host name is not resolved again, so a name that
 * answers a public address to the check and a private one to the connection
 * (DNS rebinding) reaches nothing new. TLS still verifies the certificate
 * for the URL's host name (SNI). No redirects are followed. The answer is a
 * standard Response whose body streams.
 */
export function pinnedGet(url: string, address: string, init: { headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<Response> {
  const target = new URL(url);
  const family = isIP(address);
  if (target.protocol !== "https:" || !family) return Promise.reject(new Error("blocked url"));
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target, {
      method: "GET",
      headers: init.headers,
      signal: init.signal,
      // Every lookup of this connection answers the vetted address only.
      lookup: ((_host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
        if (options?.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      }) as never,
    }, (response) => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (value === undefined) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const status = response.statusCode ?? 502;
      const empty = status === 204 || status === 304 || (status >= 300 && status < 400);
      if (empty) response.resume();
      resolve(new Response(empty ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>), { status, headers }));
    });
    request.on("error", reject);
    request.end();
  });
}

/** The image type from its first bytes; null for anything else (SVG
 * included: it can carry script). */
export function sniffImageType(bytes: Uint8Array): AvatarImageType | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

/** Quoted strong ETag of the bytes. */
export function avatarEtag(bytes: Uint8Array): string {
  return `"${createHash("sha256").update(bytes).digest("base64url").slice(0, 22)}"`;
}

/**
 * The URL boards, home and the trader page return for a cached avatar:
 * a path on this api, versioned by the ETag so it can be cached for a
 * month; null when nothing is cached (the web then draws its generated
 * avatar).
 */
export function kolAvatarPath(address: string, etag: string | null | undefined): string | null {
  if (!etag) return null;
  return `/kols/${address}/avatar?v=${avatarVersion(etag)}`;
}

/** The `v` a versioned URL carries for this ETag. */
export function avatarVersion(etag: string): string {
  return etag.replace(/"/g, "").slice(0, 12);
}
