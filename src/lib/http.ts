const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}: ${body.slice(0, 300)}`);
  }
}

export type Fetch = typeof fetch;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// fetch has no timeout of its own: one connection that never answers would
// hold a job forever. A timed-out request fails like a network error.
export const REQUEST_TIMEOUT_MS = 60_000;

export class TimeoutError extends Error {}

/** JSON request with exponential backoff on rate limits and server errors. */
export async function sendJson<T>(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  {
    attempts = 5,
    backoffMs = 1000,
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: { attempts?: number; backoffMs?: number; timeoutMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      if (attempt === attempts - 1) throw timedOut ? new TimeoutError(`no answer within ${timeoutMs} ms`) : e;
      await sleep(backoffMs * 2 ** attempt);
      continue;
    }
    if (res.ok) return (await res.json()) as T;
    const body = await res.text();
    if (!RETRY_STATUS.has(res.status) || attempt === attempts - 1) throw new HttpError(res.status, body);
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs * 2 ** attempt);
  }
}
