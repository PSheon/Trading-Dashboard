/** Server side only: reads NEXT_API_URL, which never reaches the browser. */
import { apiTarget } from "@/lib/share-card-data";
import type { TradeCardData } from "@/lib/trade-card";

const TIMEOUT_MS = 8_000;
type Fetch = typeof fetch;
interface Options { apiUrl?: string; fetchImpl?: Fetch; client?: string; authorization?: string }

/** One api read: the caller's address for apps/api's per-client limits and,
 * for the owner's own copies, the caller's own Authorization header (never
 * stored, never cached). */
async function read<T>(path: string, { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch, client, authorization }: Options): Promise<T | null> {
  const url = apiTarget(apiUrl, path);
  if (!url) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "x-api-contract": "1", ...(client ? { "X-Forwarded-For": client } : {}), ...(authorization ? { Authorization: authorization } : {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { success?: boolean; data?: T };
    return body?.success ? (body.data ?? null) : null;
  } catch {
    return null;
  }
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

interface RoundTripLike { id: string; coin: string; side: "long" | "short"; status: "open" | "closed"; entryPx: number; exitPx: number | null; size: number; holdSeconds: number; netPnl: number }
interface PositionLike { coin: string; szi: number; side: "long" | "short"; entryPx: number | null; positionValue: number; unrealizedPnl: number; leverage: number | null }

/** A trader's closed trade by id (the trader page's trades list), searched
 * over its latest 800 trades. */
export async function loadLeaderTrade(address: string, id: string, opts: Options = {}): Promise<TradeCardData | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 4; page++) {
    const body: { items: RoundTripLike[]; nextCursor: string | null } | null = await read(`/traders/${address.toLowerCase()}/trades?status=closed&limit=200${cursor ? `&cursor=${cursor}` : ""}`, opts);
    if (!body) return null;
    const t = body.items.find((x) => x.id === id);
    if (t) {
      if (t.status !== "closed" || !finite(t.netPnl)) return null;
      const notional = t.entryPx * Math.abs(t.size);
      return {
        coin: t.coin, side: t.side, leverage: null, pnl: t.netPnl, pnlPct: notional > 0 ? (t.netPnl / notional) * 100 : null,
        entryPx: t.entryPx, exitPx: t.exitPx, markPx: null, size: Math.abs(t.size), heldMs: t.holdSeconds * 1000, closed: true, paper: false,
      };
    }
    if (!body.nextCursor) return null;
    cursor = body.nextCursor;
  }
  return null;
}

/** A trader's open position in `coin`, as Hyperliquid reports it now. */
export async function loadLeaderPosition(address: string, coin: string, opts: Options = {}): Promise<TradeCardData | null> {
  const profile = await read<{ positions: PositionLike[] }>(`/traders/${address.toLowerCase()}`, opts);
  const p = profile?.positions.find((x) => x.coin === coin);
  if (!p || !p.szi || !finite(p.unrealizedPnl)) return null;
  const size = Math.abs(p.szi);
  return {
    coin: p.coin, side: p.side, leverage: p.leverage, pnl: p.unrealizedPnl,
    pnlPct: p.entryPx ? (p.unrealizedPnl / (p.entryPx * size)) * 100 : null,
    entryPx: p.entryPx, exitPx: null, markPx: size > 0 ? p.positionValue / size : null, size, heldMs: null, closed: false, paper: false,
  };
}

/** One of the caller's own closed copy trades (GET /me/copy/trades?id=). */
export async function loadCopyTrade(id: string, opts: Options): Promise<TradeCardData | null> {
  const body = await read<{ mode: string; items: Array<{ id: string; coin: string; side: "long" | "short"; size: number; entryPx: number; exitPx: number; pnl: number; roiPct: number | null; openedAt: string; closedAt: string }> }>(`/me/copy/trades?id=${id}&limit=1`, opts);
  const t = body?.items.find((x) => x.id === id);
  if (!t) return null;
  return {
    coin: t.coin, side: t.side, leverage: null, pnl: t.pnl, pnlPct: t.roiPct, entryPx: t.entryPx, exitPx: t.exitPx, markPx: null, size: t.size,
    heldMs: Math.max(0, Date.parse(t.closedAt) - Date.parse(t.openedAt)), closed: true, paper: body?.mode === "paper",
  };
}

/** One of the caller's own copy positions (GET /me/copy). */
export async function loadCopyPosition(strategyId: number, coin: string, opts: Options): Promise<TradeCardData | null> {
  const body = await read<{ mode: string; strategies: Array<{ id: number; positions: Array<{ coin: string; size: number; entryPx: number; markPx: number | null; unrealizedPnl: number | null }> }> }>("/me/copy", opts);
  const p = body?.strategies.find((s) => s.id === strategyId)?.positions.find((x) => x.coin === coin);
  if (!p || !p.size || p.unrealizedPnl === null || p.markPx === null) return null;
  const size = Math.abs(p.size);
  return {
    coin: p.coin, side: p.size > 0 ? "long" : "short", leverage: null, pnl: p.unrealizedPnl,
    pnlPct: p.entryPx > 0 ? (p.unrealizedPnl / (p.entryPx * size)) * 100 : null,
    entryPx: p.entryPx, exitPx: null, markPx: p.markPx, size, heldMs: null, closed: false, paper: body?.mode === "paper",
  };
}

/**
 * The browser-test server (NEXT_TEST_MODE=1) has no api: its cards show
 * this labelled sample so the dialog can be exercised. Never used otherwise.
 */
export function testModeSample(kind: "trade" | "position", paper: boolean): TradeCardData | null {
  if (process.env.NEXT_TEST_MODE !== "1" || process.env.NEXT_API_URL) return null;
  return kind === "trade"
    ? { coin: "SOL", side: "long", leverage: null, pnl: 42.74, pnlPct: 4.84, entryPx: 210.1, exitPx: 221.4, markPx: null, size: 4.2, heldMs: 33_600_000, closed: true, paper }
    : { coin: "BTC", side: "long", leverage: 5, pnl: 60.5, pnlPct: 1.23, entryPx: 116_980, exitPx: null, markPx: 118_420.5, size: 0.042, heldMs: null, closed: false, paper };
}
