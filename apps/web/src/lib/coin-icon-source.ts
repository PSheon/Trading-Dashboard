/** Server side only: fetches and keeps Hyperliquid's market icons, so the
 * browser loads them from this origin (app/api/coin-icon/[coin]). */

const UPSTREAM = "https://app.hyperliquid.xyz/coins";
const COIN = /^(?:[a-z0-9]{1,12}:)?[A-Za-z0-9]{1,20}$/;
const MAX_BYTES = 512 * 1024;
const TIMEOUT_MS = 5_000;
const FOUND_TTL_MS = 24 * 60 * 60 * 1000;
/** A market without an icon is asked for again after an hour; an upstream
 * failure after a minute. */
const MISSING_TTL_MS = 60 * 60 * 1000;
const FAILED_TTL_MS = 60 * 1000;
const MAX_ENTRIES = 800;

export type CoinIcon = { svg: string } | null;
type Fetch = typeof fetch;
interface Entry { icon: CoinIcon; until: number }

/** A coin name as Hyperliquid writes it ("BTC", "kPEPE", "xyz:TSLA"). */
export function isCoinName(value: string): boolean {
  return COIN.test(value);
}

/** The names to try, in order: the coin, then — for the "k" markets
 * (kPEPE is 1000 PEPE) — the coin it is a thousand of, whose icon
 * Hyperliquid's own app shows. */
export function iconCandidates(coin: string): string[] {
  return /^k[A-Z0-9]{2,}$/.test(coin) ? [coin, coin.slice(1)] : [coin];
}

/**
 * Icons by coin, fetched once and kept in memory (24 h; "no icon" 1 h; an
 * upstream failure 1 min), one upstream request per coin at a time, at
 * most `MAX_ENTRIES` coins. Hyperliquid answers 200 text/html for a market
 * without an icon, so only an `image/svg+xml` body under 512 KiB counts.
 */
export function createCoinIconSource({ fetchImpl = fetch, now = Date.now }: { fetchImpl?: Fetch; now?: () => number } = {}) {
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<CoinIcon>>();

  async function read(name: string): Promise<{ icon: CoinIcon; failed: boolean }> {
    try {
      const res = await fetchImpl(`${UPSTREAM}/${encodeURIComponent(name).replace(/%3A/gi, ":")}.svg`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (!res.ok) return { icon: null, failed: res.status >= 500 };
      if (res.headers.get("content-type")?.split(";")[0].trim() !== "image/svg+xml") return { icon: null, failed: false };
      const svg = await res.text();
      if (svg.length === 0 || svg.length > MAX_BYTES || !svg.includes("<svg")) return { icon: null, failed: false };
      return { icon: { svg }, failed: false };
    } catch {
      return { icon: null, failed: true };
    }
  }

  async function load(coin: string): Promise<CoinIcon> {
    let failed = false;
    let icon: CoinIcon = null;
    for (const name of iconCandidates(coin)) {
      const result = await read(name);
      failed ||= result.failed;
      if (result.icon) {
        icon = result.icon;
        break;
      }
    }
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
    cache.set(coin, { icon, until: now() + (icon ? FOUND_TTL_MS : failed ? FAILED_TTL_MS : MISSING_TTL_MS) });
    return icon;
  }

  return {
    /** The coin's icon, or null when it has none, the name is not a coin's, or upstream failed. */
    get(coin: string): Promise<CoinIcon> {
      if (!isCoinName(coin)) return Promise.resolve(null);
      const cached = cache.get(coin);
      if (cached && cached.until > now()) return Promise.resolve(cached.icon);
      let pending = inFlight.get(coin);
      if (!pending) {
        pending = load(coin).finally(() => inFlight.delete(coin));
        inFlight.set(coin, pending);
      }
      return pending;
    },
  };
}

export const coinIcons = createCoinIconSource();
