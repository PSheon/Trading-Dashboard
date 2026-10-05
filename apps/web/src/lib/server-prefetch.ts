/** Server side only: reads NEXT_API_URL, which never reaches the browser. */
import { findHttpContract, successEnvelopeSchema, type JsonWire, type TraderActivityResponse, type TraderProfileResponse } from "@/lib/contracts";
import { apiTarget } from "@/lib/share-card-data";
import { traderIsUnknown } from "@/lib/trader-presence";

/** A public read made while the page renders, to seed the browser's query
 * cache: the data and when it was read (the query's `initialDataUpdatedAt`). */
export interface Prefetched<T> {
  data: JsonWire<T>;
  fetchedAt: number;
}

/** Long enough for a warm api (10–130 ms for /discover/home); a slow or
 * absent api leaves the page to fetch from the browser as before. */
export const PREFETCH_TIMEOUT_MS = 1_500;

/**
 * GET `path` from apps/api for a server-rendered page, validated against the
 * same HTTP contract the browser's client uses; null on any failure (unset
 * NEXT_API_URL, timeout, non-2xx, a body outside the contract). Counted
 * against the visitor's address (`client`), as the /api/hl forwarder does.
 * Never cached here: the api caches the read.
 */
export async function prefetchPublic<T>(
  path: string,
  { apiUrl = process.env.NEXT_API_URL, fetchImpl = fetch, client, timeoutMs = PREFETCH_TIMEOUT_MS }: { apiUrl?: string; fetchImpl?: typeof fetch; client?: string; timeoutMs?: number } = {},
): Promise<Prefetched<T> | null> {
  const url = apiTarget(apiUrl, path);
  const contract = findHttpContract("GET", path);
  if (!url || !contract || contract.raw) return null;
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/json", "x-api-contract": "1", ...(client ? { "X-Forwarded-For": client } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const envelope = successEnvelopeSchema.safeParse(await res.json());
    if (!envelope.success || envelope.data.statusCode !== res.status) return null;
    const data = contract.response.safeParse(envelope.data.data);
    return data.success ? { data: data.data as JsonWire<T>, fetchedAt: Date.now() } : null;
  } catch {
    return null;
  }
}

/** What the trader page read on the server: the profile, the activity
 * when the profile alone can't tell whether the address is known, and
 * whether together they show nothing on Hyperliquid for the address
 * (`traderIsUnknown`: true → the 404, null → not known in time, the
 * browser decides as before). */
export interface PrefetchedTrader {
  profile: Prefetched<TraderProfileResponse> | null;
  activity: Prefetched<TraderActivityResponse> | null;
  unknown: boolean | null;
}

/**
 * The profile within `PREFETCH_TIMEOUT_MS`, and the activity only for a
 * blank profile (nothing held, no stats, not tracked: only its fills can
 * tell a 404 from a quiet account), within what is left of it. The
 * activity costs the api Hyperliquid's two fill lists (≈ 240 weight): read
 * for every page it spent the visitor's page budget, at the moment the
 * profile and chart needed it, on a figure only the KPI tiles' muting uses
 * (Stage, 2026-10-05: cold Top 100 profiles answered in 10–30 s). A slow
 * api leaves either one null and the page reads it from the browser.
 */
export async function prefetchTrader(
  address: string,
  options: { apiUrl?: string; fetchImpl?: typeof fetch; client?: string; timeoutMs?: number } = {},
): Promise<PrefetchedTrader> {
  const a = address.toLowerCase();
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? PREFETCH_TIMEOUT_MS;
  const profile = await prefetchPublic<TraderProfileResponse>(`/traders/${a}`, { ...options, timeoutMs });
  const decided = traderIsUnknown(profile?.data as TraderProfileResponse | undefined, undefined);
  if (!profile || decided !== null) return { profile, activity: null, unknown: decided };
  const left = timeoutMs - (Date.now() - started);
  const activity = left > 0 ? await prefetchPublic<TraderActivityResponse>(`/traders/${a}/activity`, { ...options, timeoutMs: left }) : null;
  return { profile, activity, unknown: traderIsUnknown(profile.data as TraderProfileResponse, activity?.data as TraderActivityResponse | undefined) };
}
