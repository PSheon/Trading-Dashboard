/** Server side only: reads NEXT_API_URL, which never reaches the browser. */
import { findHttpContract, successEnvelopeSchema, type JsonWire } from "@/lib/contracts";
import { apiTarget } from "@/lib/share-card-data";

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
