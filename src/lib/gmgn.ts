// GMGN OpenAPI: parsed wallet activity with USD values. Used as a second,
// independent reading of trades (and, for the backtest, a fast source of
// leader trades). https://github.com/GMGNAI/gmgn-skills

import { randomUUID } from "node:crypto";

import { type Fetch, HttpError, sendJson } from "./http";
import { Throttle } from "./throttle";

const BASE_URL = "https://openapi.gmgn.ai";
// GMGN's published demo key: read-only, for testing. Use your own from https://gmgn.ai/ai.
export const GMGN_DEMO_KEY = "gmgn_solbscbaseethmonadtron";
// Free plan: leaky bucket of 5 with rate 5 per second; wallet_activity weighs 3.
const FREE_INTERVAL_MS = 650;
const ATTEMPTS = 6;

export interface GmgnActivity {
  tx_hash: string;
  timestamp: number;
  event_type: string; // buy | sell | transferIn | transferOut | add | remove
  token: { address: string; symbol?: string };
  token_amount: string;
  quote_amount: string | null;
  quote_token?: { token_address: string; symbol?: string } | null;
  cost_usd: string | null;
  price_usd: string | null;
}

/** GMGN answered, with an error code: retrying the same request will not help. */
export class GmgnError extends Error {}

export class GmgnClient {
  requests = 0;
  rateLimited = 0;
  private readonly throttle: Throttle;

  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch; minIntervalMs?: number; backoffMs?: number } = {},
  ) {
    this.throttle = new Throttle(opts.minIntervalMs ?? FREE_INTERVAL_MS);
  }

  private async get<T>(path: string, query: Record<string, string | number | undefined>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.throttle.wait(attempt > 1 ? (this.opts.backoffMs ?? 1000) * attempt : 0);
      this.requests += 1;
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
      // Replay protection: a fresh timestamp and client id on every attempt.
      params.set("timestamp", String(Math.floor(Date.now() / 1000)));
      params.set("client_id", randomUUID());
      try {
        const body = await sendJson<{ code?: number; data?: T; msg?: string } & T>(
          this.opts.fetch ?? fetch,
          `${BASE_URL}${path}?${params}`,
          { method: "GET", headers: { "X-APIKEY": this.apiKey, "Content-Type": "application/json" } },
          { attempts: 1 },
        );
        this.throttle.recover();
        if (body.code !== undefined && body.code !== 0) throw new GmgnError(`GMGN ${path}: code ${body.code} ${body.msg ?? ""}`);
        return (body.data ?? body) as T;
      } catch (e) {
        if (e instanceof GmgnError) throw e;
        const status = e instanceof HttpError ? e.status : 0;
        if (!(status === 429 || status >= 500 || status === 0) || attempt >= ATTEMPTS) throw e;
        if (status === 429) {
          this.rateLimited += 1;
          this.throttle.slowDown();
        }
      }
    }
  }

  /** Every activity page, newest first, stopping once pages are older than `since`. */
  async *walletActivity(
    wallet: string,
    { since, pageSize = 50 }: { since?: number | null; pageSize?: number } = {},
  ): AsyncGenerator<{ activities: GmgnActivity[]; next: string | null }> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.get<{ activities?: GmgnActivity[]; next?: string }>("/v1/user/wallet_activity", {
        chain: "sol",
        wallet_address: wallet,
        limit: pageSize,
        cursor,
      });
      const activities = page.activities ?? [];
      yield { activities, next: page.next || null };
      const oldest = Math.min(...activities.map((a) => a.timestamp));
      if (!page.next || !activities.length || (since != null && oldest < since)) return;
      cursor = page.next;
    }
  }
}
