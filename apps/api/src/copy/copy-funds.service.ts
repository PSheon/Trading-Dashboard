import { Inject, Injectable } from "@nestjs/common";
import { fundsHistoryQuerySchema, type FundsFlow, type FundsHistoryResponse } from "@trading-dashboard/shared/contracts";
import { sql } from "drizzle-orm";

import { Dec } from "../common/decimal/dec.js";
import { parseOr400 } from "../common/http/validation.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { wire } from "./copy.mappers.js";

type Row = Record<string, unknown>;
const date = (v: unknown) => new Date(v as string | Date);
const num = (v: unknown) => (v === null || v === undefined ? null : wire(String(v)));

/**
 * One money-flow history (B13/B14): what Orbie itself records about the
 * owner's money, from the database only. The hub wallet's own deposits,
 * withdrawals and transfers are Hyperliquid's ledger (GET /me/wallet/history)
 * and the page merges the two, linking a hub transfer to the copy funding
 * that made it.
 */
@Injectable()
export class CopyFundsService {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async history(userId: number, query: unknown): Promise<FundsHistoryResponse> {
    const { before, limit } = parseOr400(fundsHistoryQuerySchema, query);
    const cut = before ? new Date(Number(before)) : new Date(8_640_000_000_000_000);
    const take = limit + 1;
    const [ledger, daily, funding, withdrawals] = await Promise.all([
      this.db.execute(sql`
        select l.id::text as id, l.created_at as time, l.kind, l.amount::text as amount, l.strategy_id, s.leader_address
        from copy_ledger l join copy_strategies s on s.id = l.strategy_id
        where l.user_id = ${userId} and s.user_id = ${userId} and s.mode = 'paper' and l.kind in ('allocate', 'withdraw', 'release', 'liquidation') and l.created_at < ${cut}
        order by l.created_at desc, l.id desc limit ${take}`),
      // Fees and funding per copy and UTC day, placed at their latest entry.
      this.db.execute(sql`
        select l.strategy_id, s.leader_address, case when l.kind = 'funding' then 'funding' else 'fees' end as kind,
          date_trunc('day', l.created_at at time zone 'UTC') as day, max(l.created_at) as time, sum(l.amount)::text as amount,
          count(distinct coalesce(l.order_id::text, l.id::text))::int as n
        from copy_ledger l join copy_strategies s on s.id = l.strategy_id
        where l.user_id = ${userId} and s.user_id = ${userId} and s.mode = 'paper' and l.kind in ('fee', 'builder_fee', 'funding')
        group by l.strategy_id, s.leader_address, 3, 4
        having max(l.created_at) < ${cut}
        order by max(l.created_at) desc limit ${take}`),
      this.db.execute(sql`
        select f.id, f.created_at as time, f.network, f.amount, f.status, f.transaction_hash, f.fee, f.destination, f.strategy_id, s.leader_address
        from copy_funding_operations f join copy_strategies s on s.id = f.strategy_id
        where f.user_id = ${userId} and f.created_at < ${cut} and f.status <> 'cancelled'
        order by f.created_at desc limit ${take}`),
      this.db.execute(sql`
        select id, created_at as time, network, amount, status, destination
        from wallet_withdrawals where user_id = ${userId} and created_at < ${cut} and status <> 'cancelled'
        order by created_at desc limit ${take}`),
    ]);
    const kinds: Record<string, FundsFlow["kind"]> = { allocate: "copy_deposit", withdraw: "copy_withdrawal", release: "copy_sweep", liquidation: "copy_write_off" };
    const items: FundsFlow[] = [
      ...ledger.rows.map((r: Row) => ({
        id: `ledger:${r.id}`, time: date(r.time), kind: kinds[String(r.kind)]!, mode: "paper" as const,
        // The copy's side: money in is positive (an allocation, a write-off); out negative.
        amount: wire(String(r.amount)), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: null, txHash: null, fee: null, counterparty: "paper", count: null,
      })),
      ...daily.rows.map((r: Row) => ({
        id: `${r.kind}:${r.strategy_id}:${date(r.day).toISOString().slice(0, 10)}`, time: date(r.time), kind: r.kind === "funding" ? "funding" as const : "fees" as const,
        mode: "paper" as const, amount: wire(String(r.amount)), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: null, txHash: null, fee: null, counterparty: null, count: Number(r.n),
      })),
      ...funding.rows.map((r: Row) => ({
        id: `funding:${r.id}`, time: date(r.time), kind: "copy_funding" as const, mode: r.network === "mainnet" ? "mainnet" as const : "testnet" as const,
        amount: wire(Dec.from(String(r.amount))), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: String(r.status), txHash: (r.transaction_hash as string | null) ?? null, fee: num(r.fee), counterparty: String(r.destination), count: null,
      })),
      ...withdrawals.rows.map((r: Row) => ({
        id: `withdrawal:${r.id}`, time: date(r.time), kind: "hub_withdrawal" as const, mode: r.network === "mainnet" ? "mainnet" as const : "testnet" as const,
        amount: -wire(Dec.from(String(r.amount))), strategyId: null, leaderAddress: null,
        status: String(r.status), txHash: null, fee: null, counterparty: String(r.destination), count: null,
      })),
    ].sort((a, b) => b.time.getTime() - a.time.getTime() || (a.id < b.id ? 1 : -1));
    // A page never splits one millisecond: the cursor is exclusive.
    let end = Math.min(limit, items.length);
    while (end < items.length && items[end]!.time.getTime() === items[end - 1]!.time.getTime()) end += 1;
    const page = items.slice(0, end);
    const more = items.length > end;
    return { items: page, nextCursor: more && page.length ? String(page.at(-1)!.time.getTime()) : null };
  }
}
