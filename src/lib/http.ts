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

/** JSON request with exponential backoff on rate limits and server errors. */
export async function sendJson<T>(
  fetchImpl: Fetch,
  url: string,
  init: RequestInit,
  { attempts = 5, backoffMs = 1000 }: { attempts?: number; backoffMs?: number } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(url, init);
    if (res.ok) return (await res.json()) as T;
    const body = await res.text();
    if (!RETRY_STATUS.has(res.status) || attempt === attempts - 1) throw new HttpError(res.status, body);
    const retryAfter = Number(res.headers.get("retry-after"));
    await sleep(retryAfter > 0 ? retryAfter * 1000 : backoffMs * 2 ** attempt);
  }
}
