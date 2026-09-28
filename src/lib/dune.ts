// Dune API: run SQL, wait for it, page through the rows.

import { type Fetch, sendJson, sleep } from "./http";

const BASE_URL = "https://api.dune.com/api/v1";
const DONE = "QUERY_STATE_COMPLETED";
const FAILED = new Set(["QUERY_STATE_FAILED", "QUERY_STATE_CANCELLED", "QUERY_STATE_EXPIRED"]);

export class DuneError extends Error {}

export class DuneClient {
  constructor(
    private readonly apiKey: string,
    private readonly opts: { fetch?: Fetch; pollMs?: number } = {},
  ) {}

  private call<T>(method: string, pathname: string, body?: unknown): Promise<T> {
    return sendJson<T>(this.opts.fetch ?? fetch, `${BASE_URL}${pathname}`, {
      method,
      headers: { "X-Dune-Api-Key": this.apiKey, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async executeSql(sql: string, performance = "medium"): Promise<string> {
    const r = await this.call<{ execution_id: string }>("POST", "/sql/execute", { sql, performance });
    return r.execution_id;
  }

  async wait(executionId: string, timeoutMs = 30 * 60_000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.call<Record<string, unknown>>("GET", `/execution/${executionId}/status`);
      const state = String(status.state);
      if (state === DONE) return status;
      if (FAILED.has(state)) throw new DuneError(`${executionId} ${state}: ${JSON.stringify(status.error)}`);
      if (Date.now() > deadline) throw new DuneError(`${executionId} still ${state}`);
      await sleep(this.opts.pollMs ?? 3000);
    }
  }

  async rows(executionId: string, pageSize = 10_000): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const r: { result: { rows: Record<string, unknown>[] }; next_offset?: number } = await this.call(
        "GET",
        `/execution/${executionId}/results?limit=${pageSize}&offset=${offset}`,
      );
      out.push(...r.result.rows);
      offset = r.next_offset ?? undefined;
    }
    return out;
  }

  async run(sql: string, performance = "medium") {
    const executionId = await this.executeSql(sql, performance);
    const status = await this.wait(executionId);
    return { executionId, status, rows: await this.rows(executionId) };
  }
}
