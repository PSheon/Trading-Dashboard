// Helius Parsed Events API (wallet history) and plain RPC.

import { type Fetch, sendJson, sleep } from "./http";
import type { HistoryPage, ParsedResult, RawTransaction } from "./solana";

const BASE_URL = "https://mainnet.helius-rpc.com";
export const PARSED_EVENTS_CREDITS = 10;
export const RPC_CREDITS = 1;
const MAX_EMPTY_PAGES = 20;

export interface TokenAccount {
  pubkey: string | null;
  mint: string;
  amount: bigint;
}

export class HeliusClient {
  credits = 0;
  requests = 0;
  private last = 0;

  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch; minIntervalMs?: number; backoffMs?: number } = {},
  ) {}

  private async post<T>(pathname: string, body: unknown, credits: number): Promise<T> {
    // The free plan allows 10 requests per second.
    const wait = (this.opts.minIntervalMs ?? 120) - (Date.now() - this.last);
    if (wait > 0) await sleep(wait);
    this.last = Date.now();
    this.requests += 1;
    this.credits += credits;
    const url = `${BASE_URL}${pathname}?api-key=${encodeURIComponent(this.apiKey)}`;
    return sendJson<T>(
      this.opts.fetch ?? fetch,
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      { backoffMs: this.opts.backoffMs },
    );
  }

  /** Every page of an address's history, newest first, with the request that produced it. */
  async *transactionHistory(
    address: string,
    { timeGte, includeRaw = true }: { timeGte?: number | null; includeRaw?: boolean } = {},
  ): AsyncGenerator<{ request: Record<string, unknown>; response: HistoryPage }> {
    let body: Record<string, unknown> = { address, limit: 100, includeRawTransaction: includeRaw };
    if (timeGte != null) body.time = { gte: timeGte };
    // The token, not the page size, says whether there is more: a filtered page
    // can come back empty mid-history. A long run of empty pages is a guard
    // against paging forever, not a normal end.
    let empty = 0;
    for (;;) {
      const response = await this.post<HistoryPage>(
        "/v1/parsed-events/transaction-history",
        body,
        PARSED_EVENTS_CREDITS,
      );
      yield { request: { ...body }, response };
      if (!response.paginationToken) return;
      empty = response.data?.length ? 0 : empty + 1;
      if (empty >= MAX_EMPTY_PAGES) throw new Error(`${address}: ${empty} empty pages in a row, stopping`);
      body = { ...body, paginationToken: response.paginationToken };
    }
  }

  async getTransaction(signature: string): Promise<RawTransaction | null> {
    const resp = await this.post<{ result?: RawTransaction | null; error?: unknown }>(
      "/",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "getTransaction",
        params: [signature, { encoding: "json", maxSupportedTransactionVersion: 0, commitment: "confirmed" }],
      },
      RPC_CREDITS,
    );
    if (resp.error) throw new Error(`getTransaction ${signature}: ${JSON.stringify(resp.error)}`);
    return resp.result ?? null;
  }

  /** The owner's token accounts now. */
  async tokenAccounts(owner: string, programIds: readonly string[]): Promise<TokenAccount[]> {
    const out: TokenAccount[] = [];
    for (const programId of programIds) {
      const resp = await this.post<{
        result?: { value: { pubkey?: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string } } } } } }[] };
        error?: unknown;
      }>(
        "/",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [owner, { programId }, { encoding: "jsonParsed" }],
        },
        RPC_CREDITS,
      );
      if (resp.error || !resp.result) {
        throw new Error(`getTokenAccountsByOwner ${owner}: ${JSON.stringify(resp.error)}`);
      }
      for (const acc of resp.result.value) {
        const info = acc.account.data.parsed.info;
        out.push({ pubkey: acc.pubkey ?? null, mint: info.mint, amount: BigInt(info.tokenAmount.amount) });
      }
    }
    return out;
  }

  async tokenBalances(owner: string, programIds: readonly string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    for (const acc of await this.tokenAccounts(owner, programIds)) {
      out.set(acc.mint, (out.get(acc.mint) ?? 0n) + acc.amount);
    }
    return out;
  }
}

/** The getTransaction-shaped payload inside a Parsed Events result, if usable. */
export function rawTransaction(result: ParsedResult): RawTransaction | null {
  let raw = result.rawTransaction as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // Some encodings nest the whole RPC result one level down.
  const nested = raw.transaction as Record<string, unknown> | undefined;
  if (!("meta" in raw) && nested && typeof nested === "object" && "meta" in nested) raw = nested;
  const tx = raw.transaction as Record<string, unknown> | undefined;
  if (!("meta" in raw) || !tx || typeof tx !== "object" || Array.isArray(tx) || !("message" in tx)) {
    return null; // base64 or another encoding the normalizer cannot read
  }
  const out = { ...raw } as unknown as RawTransaction;
  out.slot ??= result.parsed?.slot as number;
  out.blockTime ??= result.parsed?.blockTime ?? null;
  return out;
}
