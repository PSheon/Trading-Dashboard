import { Injectable } from "@nestjs/common";
import type { CopyFollowerStatement } from "@trading-dashboard/shared/contracts";
import { Dec } from "../common/decimal/dec.js";
import { CopyFollowerStatementRepository } from "./copy-follower-statement.repository.js";

@Injectable()
export class CopyFollowerStatementService {
  constructor(private readonly repository: CopyFollowerStatementRepository) {}
  async get(userId: number, accountId: string): Promise<CopyFollowerStatement> {
    const { account, totals, receiptCount, receipts, state, scan } = await this.repository.getOwnedSnapshot(userId, accountId);
      const amounts = new Map(totals.map(row => [row.component, row.amount]));
      const value = (key: "realized_pnl" | "exchange_fee" | "builder_fee" | "funding") => Dec.from(amounts.get(key) ?? "0").toString();
      const actual = { realizedPnl: value("realized_pnl"), exchangeFee: value("exchange_fee"), builderFee: value("builder_fee"), funding: value("funding"),
        tradingCashDelta: totals.reduce((sum, row) => sum.add(Dec.from(row.amount)), Dec.from(0)).toString() };
      const pending = scan?.scanState && typeof scan.scanState === "object" && "pending" in scan.scanState && Array.isArray(scan.scanState.pending) ? scan.scanState.pending.length : null;
      return { accountId, strategyId: account.strategyId, network: account.network, accountAddress: account.address, token: "USDC", receiptCount: receiptCount,
        actual, quarantine: { blocked: state?.quarantined ?? false, reason: state?.reason ?? null },
        coverage: { historicalCompleteness: "unproven", scannedThrough: scan?.through == null ? null : new Date(scan.through).toISOString(),
          unresolvedWindows: pending, issue: scan?.issue ?? null, updatedAt: scan?.updatedAt.toISOString() ?? null },
        latestReceipts: receipts.map(row => ({ key: row.key, kind: row.kind, coin: row.coin, time: row.providerTime.toISOString(), attribution: row.attribution, executionKey: row.executionKey })) };
  }
}
