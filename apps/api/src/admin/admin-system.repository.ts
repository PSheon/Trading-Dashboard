import { Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import type { AdminSystemOverview, RetentionStatus } from "@trading-dashboard/shared/contracts";
import { DATABASE_POOL } from "../db/drizzle.provider.js";

@Injectable()
export class AdminSystemRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  private async query<T extends Record<string, unknown>>(text: string): Promise<T[]> {
    // Bound both server work and client waiting, without changing shared-pool defaults.
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '2000ms'");
      const query = { text, query_timeout: 2500 };
      const result = await client.query<T>(query);
      await client.query("COMMIT");
      client.release();
      return result.rows;
    } catch (error) {
      // Destroy the connection: a timed-out query must not leave a transaction in the pool.
      client.release(true);
      throw error;
    }
  }

  async probe(): Promise<number> {
    const start = performance.now();
    await this.query("SELECT 1");
    return Math.round(performance.now() - start);
  }

  async data(): Promise<NonNullable<AdminSystemOverview["data"]>> {
    const [row] = await this.query<NonNullable<AdminSystemOverview["data"]>>(`SELECT
      (SELECT count(*)::int FROM trader_stats) AS "leaderboardCount",
      (SELECT max(updated_at) FROM trader_stats) AS "leaderboardUpdatedAt",
      (SELECT count(*)::int FROM leaders WHERE active) AS watched,
      json_build_object('leaderboardThresholdMinutes', 60, 'portfolioThresholdMinutes', 1440, 'tradesThresholdMinutes', 1440,
        'leaderboard', (SELECT CASE WHEN max(updated_at) IS NULL THEN 'missing' WHEN max(updated_at) < now() - interval '60 minutes' THEN 'stale' ELSE 'fresh' END FROM trader_stats),
        'portfolioStale', count(*) FILTER (WHERE portfolio_at < now() - interval '24 hours'),
        'portfolioMissing', count(*) FILTER (WHERE portfolio_at IS NULL),
        'tradesStale', count(*) FILTER (WHERE trades_at < now() - interval '24 hours'),
        'tradesMissing', count(*) FILTER (WHERE trades_at IS NULL)) AS freshness,
      count(*)::int AS candidates,
      count(portfolio_at)::int AS portfolios, count(trades_at)::int AS trades,
      count(*) FILTER (WHERE last_error IS NOT NULL)::int AS errors,
      min(portfolio_at) AS "oldestPortfolioAt", max(portfolio_at) AS "newestPortfolioAt"
      FROM discovery_traders WHERE in_pool`);
    return JSON.parse(JSON.stringify(row));
  }

  /** The retention job's last run; a state row that does not exist yet reads as "never ran". */
  async retention(): Promise<RetentionStatus> {
    const [row] = await this.query<RetentionStatus>(`SELECT
      coalesce(locked_until > now(), false) AS running,
      last_started_at AS "lastStartedAt", last_finished_at AS "lastFinishedAt", last_status AS "lastStatus",
      removed, cutoffs, last_error AS "lastError", duration_ms AS "durationMs"
      FROM retention_state WHERE id = 1`);
    return row ? JSON.parse(JSON.stringify(row))
      : { running: false, lastStartedAt: null, lastFinishedAt: null, lastStatus: null, removed: null, cutoffs: null, lastError: null, durationMs: null };
  }

  async outbox(): Promise<NonNullable<AdminSystemOverview["outbox"]>> {
    const parts = ([['action_outbox', 'evaluations'], ['notification_outbox', 'deliveries']] as const).map(([table, kind]) => `SELECT '${kind}' AS kind,
      count(*) FILTER (WHERE status = 'pending')::int AS pending,
      count(*) FILTER (WHERE status = 'processing')::int AS processing,
      count(*) FILTER (WHERE status = 'failed')::int AS failed,
      count(*) FILTER (WHERE status = 'pending' AND available_at <= now())::int AS due,
      count(*) FILTER (WHERE status = 'processing' AND locked_until <= now())::int AS "expiredLeases",
      min(available_at) FILTER (WHERE status = 'pending' AND available_at <= now()) AS "oldestDueAt"
      FROM ${table} WHERE status IN ('pending', 'processing', 'failed')`);
    return JSON.parse(JSON.stringify(await this.query(parts.join(" UNION ALL "))));
  }
}
