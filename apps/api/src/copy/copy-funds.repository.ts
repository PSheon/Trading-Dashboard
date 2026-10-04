import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export type FundsRow = Record<string, unknown>;

/** The owner's money flows as Orbie records them, newest first, each list
 * at most `take` rows before `cut`. */
@Injectable()
export class CopyFundsRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  /** Paper copies' allocations, withdrawals, sweeps and write-offs. */
  async ledgerTransfers(userId: number, cut: Date, take: number): Promise<FundsRow[]> {
    return (await this.db.execute(sql`
      select l.id::text as id, l.created_at as time, l.kind, l.amount::text as amount, l.strategy_id, s.leader_address
      from copy_ledger l join copy_strategies s on s.id = l.strategy_id
      where l.user_id = ${userId} and s.user_id = ${userId} and s.mode = 'paper' and l.kind in ('allocate', 'withdraw', 'release', 'liquidation') and l.created_at < ${cut}
      order by l.created_at desc, l.id desc limit ${take}`)).rows;
  }

  /** Fees and funding per copy and UTC day, placed at their latest entry. */
  async dailyCosts(userId: number, cut: Date, take: number): Promise<FundsRow[]> {
    return (await this.db.execute(sql`
      select l.strategy_id, s.leader_address, case when l.kind = 'funding' then 'funding' else 'fees' end as kind,
        date_trunc('day', l.created_at at time zone 'UTC') as day, max(l.created_at) as time, sum(l.amount)::text as amount,
        count(distinct coalesce(l.order_id::text, l.id::text))::int as n
      from copy_ledger l join copy_strategies s on s.id = l.strategy_id
      where l.user_id = ${userId} and s.user_id = ${userId} and s.mode = 'paper' and l.kind in ('fee', 'builder_fee', 'funding')
      group by l.strategy_id, s.leader_address, 3, 4
      having max(l.created_at) < ${cut}
      order by max(l.created_at) desc limit ${take}`)).rows;
  }

  /** Hub-to-copy-wallet fundings (live copies), cancelled ones left out. */
  async copyFundings(userId: number, cut: Date, take: number): Promise<FundsRow[]> {
    return (await this.db.execute(sql`
      select f.id, f.created_at as time, f.network, f.amount, f.status, f.transaction_hash, f.fee, f.destination, f.strategy_id, s.leader_address
      from copy_funding_operations f join copy_strategies s on s.id = f.strategy_id
      where f.user_id = ${userId} and f.created_at < ${cut} and f.status <> 'cancelled'
      order by f.created_at desc limit ${take}`)).rows;
  }

  /** Hub withdrawals Orbie submitted, cancelled ones left out. */
  async hubWithdrawals(userId: number, cut: Date, take: number): Promise<FundsRow[]> {
    return (await this.db.execute(sql`
      select id, created_at as time, network, amount, status, destination
      from wallet_withdrawals where user_id = ${userId} and created_at < ${cut} and status <> 'cancelled'
      order by created_at desc limit ${take}`)).rows;
  }
}
