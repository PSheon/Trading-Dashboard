/** Server side only: reads NEXT_API_URL, which never reaches the browser. */
import type { CoinBoardResponse, TraderWindow } from "@/lib/contracts";
import { shareCardData, type ShareCardData } from "@/lib/share-card";

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

const TRADE_WINDOW: Record<TraderWindow, string> = { day: "1d", week: "7d", month: "30d", allTime: "all" };
const TIMEOUT_MS = 8_000;
/** The card is cached for a few minutes, like the portfolio it shows. */
export const SHARE_REVALIDATE_S = 300;

type Fetch = typeof fetch;

/** apps/api's URL for a path, kept under NEXT_API_URL's origin and base path
 * (as the /api/hl forwarder does); null when unset or invalid. */
export function apiTarget(apiUrl: string | undefined, path: string): URL | null {
  if (!apiUrl || !path.startsWith("/") || path.startsWith("//")) return null;
  let base: URL;
  try {
    base = new URL(apiUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  const target = new URL(`${base.pathname.replace(/\/+$/, "")}${path}`, base.origin);
  return target.origin === base.origin ? target : null;
}

/** Who this server is asking for: apps/api counts the read against that
 * address (its rate limit and Hyperliquid page budget), not against this
 * server, whose one bucket every visitor would otherwise share. */
const onBehalfOf = (client: string | undefined): Record<string, string> => (client ? { "X-Forwarded-For": client } : {});

async function getJson<T>(fetchImpl: Fetch, apiUrl: string | undefined, path: string, timeoutMs = TIMEOUT_MS, client?: string): Promise<T | null> {
  const url = apiTarget(apiUrl, path);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "x-api-contract": "1", ...onBehalfOf(client) },
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: SHARE_REVALIDATE_S },
    } as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: T };
    return body?.success ? (body.data ?? null) : null;
  } catch {
    return null;
  }
}

/** A cached KOL avatar (an api path) as a data URI the renderer can embed;
 * PNG and JPEG only, at most 1 MB. Absolute URLs are not fetched. */
async function avatarDataUri(fetchImpl: Fetch, apiUrl: string | undefined, path: string | null | undefined, client?: string): Promise<string | null> {
  if (!path) return null;
  const url = apiTarget(apiUrl, path);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { headers: onBehalfOf(client), signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate: SHARE_REVALIDATE_S } } as RequestInit);
    const type = res.headers.get("content-type")?.split(";")[0].trim();
    if (!res.ok || (type !== "image/png" && type !== "image/jpeg")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 1_000_000) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/** The trader's name for the browser tab (KOL or leaderboard name), from
 * the api's search index: a database read, so the title never waits on
 * Hyperliquid. null when there is none or the api is slow. */
export async function loadTraderName(
  address: string,
  { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch, client }: { apiUrl?: string; fetchImpl?: Fetch; client?: string } = {},
): Promise<string | null> {
  const lower = address.toLowerCase();
  const found = await getJson<{ items: Array<{ address: string; displayName: string | null }> }>(fetchImpl, apiUrl, `/discover/search?q=${lower}&limit=1`, 2_000, client);
  return found?.items.find((item) => item.address.toLowerCase() === lower)?.displayName?.trim() || null;
}

/** One coin's board (GET /discover/coins/:coin: a snapshot read, no
 * Hyperliquid call), for the coin page to decide between the page and the
 * 404 before anything is sent. null when the api is unset, slow or failing. */
export function loadCoinBoard(
  coin: string,
  { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch, client }: { apiUrl?: string; fetchImpl?: Fetch; client?: string } = {},
): Promise<Pick<CoinBoardResponse, "items" | "stats" | "pool"> | null> {
  return getJson<Pick<CoinBoardResponse, "items" | "stats" | "pool">>(fetchImpl, apiUrl, `/discover/coins/${encodeURIComponent(coin)}`, 3_000, client);
}

/** What the sitemap lists besides the fixed pages: every market on the coin
 * index and the traders on the public boards (database reads, no
 * Hyperliquid call). Empty when the api is unset or failing: the sitemap
 * then has the fixed pages only. */
export async function loadSitemapData({ apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch }: { apiUrl?: string; fetchImpl?: Fetch } = {}): Promise<{ coins: string[]; traders: string[] }> {
  const board = (query: string) => getJson<{ items: Array<{ address: string }> }>(fetchImpl, apiUrl, `/discover/boards?${query}`, TIMEOUT_MS);
  const [index, ...boards] = await Promise.all([
    getJson<{ items: Array<{ coin: string }> }>(fetchImpl, apiUrl, "/discover/coins", TIMEOUT_MS),
    board("board=kol&market=crypto&sort=copyScore&window=all"),
    board("board=top100&market=crypto&sort=copyScore&window=all"),
    board("board=top100&market=crypto&sort=pnl&window=all"),
    board("board=top100&market=stocks&sort=pnl&window=all"),
  ]);
  const traders = new Set<string>();
  for (const b of boards) for (const item of b?.items ?? []) if (ADDRESS_RE.test(item.address)) traders.add(item.address.toLowerCase());
  return { coins: [...new Set((index?.items ?? []).map((item) => item.coin))], traders: [...traders] };
}

interface ProfileLike {
  displayName?: string | null;
  kol?: { displayName: string | null; avatarUrl: string | null } | null;
}
interface PortfolioLike {
  pnl: Array<[number, number]>;
  roi: number | null;
}
interface AnalyticsLike {
  summary: { winRate: number | null };
}

/** Everything the card shows, read from apps/api server-side: profile
 * (name, KOL avatar), the period's perp portfolio (PnL, ROI, the line) and
 * its trade analytics (win rate; all-time when the period has none). Any
 * part that fails is left empty, so the card still renders. `client`: the
 * address of whoever asked for the card (see `onBehalfOf`). */
export async function loadShareCard(
  address: string,
  period: TraderWindow,
  { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch, client }: { apiUrl?: string; fetchImpl?: Fetch; client?: string } = {},
): Promise<ShareCardData> {
  const a = address.toLowerCase();
  const [profile, portfolio, analytics, allTime] = await Promise.all([
    getJson<ProfileLike>(fetchImpl, apiUrl, `/traders/${a}`, TIMEOUT_MS, client),
    getJson<PortfolioLike>(fetchImpl, apiUrl, `/traders/${a}/portfolio?window=${period}&market=perp`, TIMEOUT_MS, client),
    getJson<AnalyticsLike>(fetchImpl, apiUrl, `/traders/${a}/analytics?window=${TRADE_WINDOW[period]}`, TIMEOUT_MS, client),
    period === "allTime" ? Promise.resolve(null) : getJson<AnalyticsLike>(fetchImpl, apiUrl, `/traders/${a}/analytics?window=all`, TIMEOUT_MS, client),
  ]);
  const avatar = await avatarDataUri(fetchImpl, apiUrl, profile?.kol?.avatarUrl, client);
  return shareCardData({
    address: a,
    profile,
    avatar,
    period,
    portfolio,
    winRate: analytics?.summary.winRate ?? null,
    allTimeWinRate: allTime?.summary.winRate ?? null,
  });
}
