/** Server side only: reads NEXT_API_URL, which never reaches the browser. */
import type { TraderWindow } from "@/lib/contracts";
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

async function getJson<T>(fetchImpl: Fetch, apiUrl: string | undefined, path: string): Promise<T | null> {
  const url = apiTarget(apiUrl, path);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "x-api-contract": "1" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
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
async function avatarDataUri(fetchImpl: Fetch, apiUrl: string | undefined, path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const url = apiTarget(apiUrl, path);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), next: { revalidate: SHARE_REVALIDATE_S } } as RequestInit);
    const type = res.headers.get("content-type")?.split(";")[0].trim();
    if (!res.ok || (type !== "image/png" && type !== "image/jpeg")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > 1_000_000) return null;
    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
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
 * part that fails is left empty, so the card still renders. */
export async function loadShareCard(
  address: string,
  period: TraderWindow,
  { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch }: { apiUrl?: string; fetchImpl?: Fetch } = {},
): Promise<ShareCardData> {
  const a = address.toLowerCase();
  const [profile, portfolio, analytics, allTime] = await Promise.all([
    getJson<ProfileLike>(fetchImpl, apiUrl, `/traders/${a}`),
    getJson<PortfolioLike>(fetchImpl, apiUrl, `/traders/${a}/portfolio?window=${period}&market=perp`),
    getJson<AnalyticsLike>(fetchImpl, apiUrl, `/traders/${a}/analytics?window=${TRADE_WINDOW[period]}`),
    period === "allTime" ? Promise.resolve(null) : getJson<AnalyticsLike>(fetchImpl, apiUrl, `/traders/${a}/analytics?window=all`),
  ]);
  const avatar = await avatarDataUri(fetchImpl, apiUrl, profile?.kol?.avatarUrl);
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
