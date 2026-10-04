import { Injectable } from "@nestjs/common";
import { fundsHistoryQuerySchema, type FundsFlow, type FundsHistoryResponse } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
import { parseOr400 } from "../common/http/validation.js";
import { CopyFundsRepository, type FundsRow as Row } from "./copy-funds.repository.js";
import { wire } from "./copy.mappers.js";
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
  constructor(private readonly repository: CopyFundsRepository) {}

  async history(userId: number, query: unknown): Promise<FundsHistoryResponse> {
    const { before, limit } = parseOr400(fundsHistoryQuerySchema, query);
    const cut = before ? new Date(Number(before)) : new Date(8_640_000_000_000_000);
    const take = limit + 1;
    const [ledger, daily, funding, withdrawals] = await Promise.all([
      this.repository.ledgerTransfers(userId, cut, take),
      this.repository.dailyCosts(userId, cut, take),
      this.repository.copyFundings(userId, cut, take),
      this.repository.hubWithdrawals(userId, cut, take),
    ]);
    const kinds: Record<string, FundsFlow["kind"]> = { allocate: "copy_deposit", withdraw: "copy_withdrawal", release: "copy_sweep", liquidation: "copy_write_off" };
    const items: FundsFlow[] = [
      ...ledger.map((r: Row) => ({
        id: `ledger:${r.id}`, time: date(r.time), kind: kinds[String(r.kind)]!, mode: "paper" as const,
        // The copy's side: money in is positive (an allocation, a write-off); out negative.
        amount: wire(String(r.amount)), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: null, txHash: null, fee: null, counterparty: "paper", count: null,
      })),
      ...daily.map((r: Row) => ({
        id: `${r.kind}:${r.strategy_id}:${date(r.day).toISOString().slice(0, 10)}`, time: date(r.time), kind: r.kind === "funding" ? "funding" as const : "fees" as const,
        mode: "paper" as const, amount: wire(String(r.amount)), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: null, txHash: null, fee: null, counterparty: null, count: Number(r.n),
      })),
      ...funding.map((r: Row) => ({
        id: `funding:${r.id}`, time: date(r.time), kind: "copy_funding" as const, mode: r.network === "mainnet" ? "mainnet" as const : "testnet" as const,
        amount: wire(Dec.from(String(r.amount))), strategyId: Number(r.strategy_id), leaderAddress: String(r.leader_address),
        status: String(r.status), txHash: (r.transaction_hash as string | null) ?? null, fee: num(r.fee), counterparty: String(r.destination), count: null,
      })),
      ...withdrawals.map((r: Row) => ({
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
