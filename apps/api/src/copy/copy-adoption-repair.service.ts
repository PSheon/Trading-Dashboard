import { Injectable, Logger } from "@nestjs/common";
import type { CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { UnitOfWork } from "../db/unit-of-work.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { CopyMarketService } from "./copy-market.service.js";
import { cloidOf, openNotional } from "./copy-math.js";
import { CopyOrderPlanner, marketDataGap, strategyValue } from "./copy-planner.service.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository } from "./copy.repository.js";

/** Rejection reasons that, before market-data gaps were retried, could mean
 * "the read failed" rather than a fact about the coin. */
export const TRANSIENT_ADOPT_REASONS = ["no_asset_info", "no_price"];

/** Dedupe key of the one repair order a (strategy, coin) may ever get. */
export const adoptionRepairKey = (strategyId: number, coin: string) => `${strategyId}:adopt:${coin}:repair1`;
const originalAdoptKey = (strategyId: number, coin: string) => `${strategyId}:adopt:${coin}:v1`;

export type AdoptionRepairOutcome =
  /** A new adopt order was written (`orderStatus` risk_approved, or rejected with a real reason). */
  | "ordered"
  | "would_order"
  /** Nothing written; a later run may still repair it. */
  | "market_data_unavailable" | "leader_unavailable" | "leader_trading"
  /** Nothing written and nothing left to repair. */
  | "leader_flat" | "already_positioned" | "already_repaired" | "strategy_not_active";

export interface AdoptionRepairItem {
  strategyId: number;
  coin: string;
  rejectedOrderId: string;
  rejectedReason: string | null;
  outcome: AdoptionRepairOutcome;
  orderId?: string;
  orderStatus?: string;
  orderReason?: string | null;
  side?: "B" | "A";
  size?: number;
  notional?: number;
}

/**
 * Re-runs adoption for copies that started without the leader's positions
 * because market data failed to load at that moment (before that became a
 * 503): active strategies whose original adopt leg of a coin was rejected
 * with `no_asset_info` / `no_price` and that have no other adopt order for
 * that coin.
 *
 * Each is adopted from the leader's position now, sized as at the start
 * (ratio: leader notional × strategy equity / leader equity; fixed: the
 * per-trade amount) and risk-checked by the planner like any adopt leg,
 * priced at the mid now. The new order has its own dedupe key
 * ({@link adoptionRepairKey}), one per (strategy, coin) for ever: a second
 * run, a concurrent run or a replay finds it and writes nothing. The
 * executor fills it on its next pass.
 *
 * Nothing is written when the leader no longer holds the coin, when the
 * strategy already has a position or an open order in it (the leader traded
 * it since and those fills were copied), when the leader has fills the
 * consumer hasn't finished, or when market data is still missing.
 *
 * Not exact to the fill: a leader fill made before the snapshot read here
 * but stored after this commit is in the adopted size and is also copied
 * as a signal. The check for unfinished fills narrows that to the watcher's
 * lag (seconds); run it while the leader is quiet.
 */
@Injectable()
export class CopyAdoptionRepairService {
  private readonly logger = new Logger(CopyAdoptionRepairService.name);

  constructor(
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly planner: CopyOrderPlanner,
    private readonly policies: CopyRiskPolicyService,
  ) {}

  async repair(options: { dryRun?: boolean; strategyId?: number } = {}): Promise<AdoptionRepairItem[]> {
    const rows = await this.repository.rejectedAdoptions(TRANSIENT_ADOPT_REASONS, options.strategyId);
    // Only the adoption made when the copy started, never an earlier repair.
    const candidates = rows.map((r) => r.order).filter((o) => o.cloid === cloidOf(originalAdoptKey(o.strategyId, o.coin)));
    const out: AdoptionRepairItem[] = [];
    if (candidates.length === 0) return out;

    // Upstream reads happen before the transaction, never inside it.
    const mids = await this.market.midPrices();
    const assets = await this.market.assetInfo();
    const snapshots = new Map<string, HlClearinghouseStateResponse | null>();
    for (const address of new Set(candidates.map((o) => o.leaderAddress))) {
      try {
        snapshots.set(address, await this.market.leaderSnapshot(address));
      } catch (error) {
        this.logger.warn(`Leader snapshot for ${address} failed: ${(error as Error).message}`);
        snapshots.set(address, null);
      }
    }

    for (const rejected of candidates) {
      const item: AdoptionRepairItem = { strategyId: rejected.strategyId, coin: rejected.coin, rejectedOrderId: String(rejected.id), rejectedReason: rejected.reason, outcome: "already_repaired" };
      out.push(item);
      const snapshot = snapshots.get(rejected.leaderAddress) ?? null;
      if (!snapshot) { item.outcome = "leader_unavailable"; continue; }
      if (marketDataGap(mids, assets, rejected.coin)) { item.outcome = "market_data_unavailable"; continue; }
      const held = snapshot.assetPositions.find((ap) => ap.position.coin === rejected.coin);
      const szi = Number(held?.position.szi ?? 0);
      if (!held || !Number.isFinite(szi) || szi === 0) { item.outcome = "leader_flat"; continue; }
      const leaderPx = Number(held.position.positionValue ?? 0) / Math.abs(szi) || Number(held.position.entryPx ?? 0);
      const leaderEquity = Number(snapshot.marginSummary.accountValue);

      await this.uow.run(async (tx) => {
        // Lock order: controls (share), the leader (as activation does), then the strategy.
        const controls = await this.repository.readControls(rejected.userId, "share", tx);
        await this.repository.lockLeader(tx, rejected.leaderAddress);
        const strategy = await this.repository.lockStrategy(tx, rejected.strategyId);
        if (!strategy || strategy.status !== "active") { item.outcome = "strategy_not_active"; return; }
        if ((await this.repository.adoptOrderCount(tx, strategy.id, rejected.coin)) > 1) { item.outcome = "already_repaired"; return; }
        if ((await this.repository.unfinishedOutboxCount(tx, strategy.leaderAddress)) > 0) { item.outcome = "leader_trading"; return; }
        const positions = await this.repository.positionsOf([strategy.id], tx);
        const pending = await this.repository.pendingSizes(tx, strategy.id);
        if (positions.some((p) => p.coin === rejected.coin) || (pending.get(rejected.coin) ?? 0) !== 0) { item.outcome = "already_positioned"; return; }

        const settings = (await this.repository.settingsOf(tx, strategy.id, strategy.version)) as CopyStrategySettings;
        const policy = await this.policies.current(tx);
        const leaderSign: 1 | -1 = szi > 0 ? 1 : -1;
        const sign = settings.direction === "same" ? leaderSign : (-leaderSign as 1 | -1);
        const equity = strategyValue(strategy, positions, mids).equity;
        const notional = equity === null ? null : openNotional({
          mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional: Math.abs(szi) * leaderPx,
          strategyEquity: equity, leaderEquity: Number.isFinite(leaderEquity) ? leaderEquity : null,
        });
        item.side = sign > 0 ? "B" : "A";
        item.notional = notional ?? undefined;
        if (options.dryRun) { item.outcome = "would_order"; return; }
        const order = await this.planner.place(tx, {
          strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids, assets,
          coin: rejected.coin, leg: "adopt", side: item.side, notional: notional ?? 0,
          signalPx: mids?.px.get(rejected.coin) ?? leaderPx, signalTime: new Date(), signalTids: [],
          dedupeKey: adoptionRepairKey(strategy.id, rejected.coin),
          rejectReason: notional !== null ? undefined : equity === null ? "no_price" : settings.sizingMode === "ratio" ? "leader_equity_unknown" : "no_per_trade_amount",
        });
        if (!order) return;
        Object.assign(item, { outcome: "ordered", orderId: String(order.id), orderStatus: order.status, orderReason: order.reason, size: Number(order.size) });
      });
    }
    return out;
  }
}
