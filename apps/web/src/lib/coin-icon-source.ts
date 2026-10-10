/** Server side only: fetches and keeps Hyperliquid's market icons, so the
 * browser loads them from this origin (app/api/coin-icon/[coin]). */
import { loadMarketNames } from "./share-card-data";

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
/** The market list is re-read this often; a failed read after a minute. */
const MARKETS_TTL_MS = 60 * 60 * 1000;
const MARKETS_RETRY_MS = 60 * 1000;
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
export function createCoinIconSource({ fetchImpl = fetch, now = Date.now, markets }: {
  fetchImpl?: Fetch; now?: () => number;
  /** The known market names (apps/api's catalog), or null when unknown.
   * Without it every well-formed name is fetched (tests). */
  markets?: () => Promise<readonly string[] | null>;
} = {}) {
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<CoinIcon>>();
  let known: { names: ReadonlySet<string>; until: number } | null = null;
  let knownLoading: Promise<ReadonlySet<string> | null> | null = null;
  /** No list was ever read: the next attempt is not before this. */
  let unknownUntil = 0;

  /** Only a known market is asked for upstream: an arbitrary name that fits
   * the pattern would otherwise cost one request to app.hyperliquid.xyz
   * each (audit C). An unreadable list refuses until it can be read, and is
   * asked for again after `MARKETS_RETRY_MS`, not on every icon request
   * (the last list read stays in use meanwhile). */
  async function isKnown(coin: string): Promise<boolean> {
    if (!markets) return true;
    if (!known && unknownUntil > now()) return false;
    if (!known || known.until <= now()) {
      const failed = () => {
        if (known) known = { names: known.names, until: now() + MARKETS_RETRY_MS };
        else unknownUntil = now() + MARKETS_RETRY_MS;
        return known?.names ?? null;
      };
      knownLoading ??= markets().then((names) => {
        if (!names) return failed();
        known = { names: new Set(names), until: now() + MARKETS_TTL_MS };
        return known.names;
      }).catch(failed).finally(() => { knownLoading = null; });
      await knownLoading;
    }
    return known?.names.has(coin) ?? false;
  }

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
    if (!(await isKnown(coin))) return null;
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
    /** Distinguish an optional missing logo from an unknown market. */
    isKnownMarket(coin: string): Promise<boolean> {
      return isCoinName(coin) ? isKnown(coin) : Promise.resolve(false);
    },
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

export const coinIcons = createCoinIconSource({ markets: () => loadMarketNames() });
