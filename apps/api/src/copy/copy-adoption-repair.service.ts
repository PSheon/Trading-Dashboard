import { Injectable, Logger } from "@nestjs/common";
import type { CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { CopyMarketService, type LeaderEquity } from "./copy-market.service.js";
import { cloidOf, leaderPositionPx, openNotional } from "./copy-math.js";
import { CopyOrderPlanner, marketDataGap, strategyValue } from "./copy-planner.service.js";
import { pricedCoins, symbolRefusal } from "./copy-risk.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository } from "./copy.repository.js";
import { wire } from "./copy.mappers.js";
import { safeErrorText } from "../runtime/safe-error-text.js";

/** Rejection reasons that, before market-data gaps were retried, could mean
 * "the read failed" rather than a fact about the coin. */
const TRANSIENT_ADOPT_REASONS = ["no_asset_info", "no_price"];

/** Dedupe key of the one repair order a (strategy, coin) may ever get. */
export const adoptionRepairKey = (strategyId: number, coin: string) => `${strategyId}:adopt:${coin}:repair1`;
const originalAdoptKey = (strategyId: number, coin: string) => `${strategyId}:adopt:${coin}:v1`;

type AdoptionRepairOutcome =
  /** A new adopt order was written (`orderStatus` risk_approved, or rejected with a real reason). */
  | "ordered"
  | "would_order"
  /** Nothing written; a later run may still repair it. */
  | "market_data_unavailable" | "leader_unavailable" | "leader_trading"
  /** Nothing written and nothing left to repair. */
  | "leader_flat" | "already_positioned" | "already_repaired" | "strategy_not_active";

interface AdoptionRepairItem {
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
 * Re-runs adoption for active copies whose original adopt leg was rejected `no_asset_info` /
 * `no_price` (a failed read) and that have no other adopt order for the coin. Sized as at the
 * start, risk-checked like any adopt leg, keyed once per (strategy, coin) by
 * {@link adoptionRepairKey} so reruns write nothing.
 *
 * Skipped when the leader no longer holds the coin, the strategy already has a position or open
 * order in it, the leader has unfinished fills, or data is still missing. Not exact: a fill
 * stored after the snapshot can be counted twice within the watcher's lag; run while the leader is quiet.
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
    const limits = (await this.policies.current()).limits;
    const coins = pricedCoins(limits, candidates.map((o) => o.coin));
    const mids = await this.market.midPrices(coins);
    const assets = await this.market.assetInfo(coins);
    const snapshots = new Map<string, Awaited<ReturnType<CopyMarketService["leaderSnapshot"]>> | null>();
    const equities = new Map<string, LeaderEquity>();
    for (const address of new Set(candidates.map((o) => o.leaderAddress))) {
      try {
        snapshots.set(address, await this.market.leaderSnapshot(address));
        equities.set(address, await this.market.leaderEquity(address));
      } catch (error) {
        this.logger.warn(`Leader snapshot for ${address} failed: ${safeErrorText(error)}`);
        snapshots.set(address, null);
      }
    }

    for (const rejected of candidates) {
      const item: AdoptionRepairItem = { strategyId: rejected.strategyId, coin: rejected.coin, rejectedOrderId: String(rejected.id), rejectedReason: rejected.reason, outcome: "already_repaired" };
      out.push(item);
      const snapshot = snapshots.get(rejected.leaderAddress) ?? null;
      const equityRead = equities.get(rejected.leaderAddress) ?? { state: "failed" };
      if (!snapshot || equityRead.state === "failed") { item.outcome = "leader_unavailable"; continue; }
      if (symbolRefusal(limits, rejected.coin) === null && marketDataGap(mids, assets, rejected.coin)) { item.outcome = "market_data_unavailable"; continue; }
      const held = snapshot.assetPositions.find((ap) => ap.position.coin === rejected.coin);
      const szi = Dec.parse(held?.position.szi) ?? Dec.ZERO;
      if (!held || szi.isZero) { item.outcome = "leader_flat"; continue; }
      const leaderPx = leaderPositionPx(held.position);
      const leaderEquity = equityRead.state === "known" ? equityRead.value : null;

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
        if (positions.some((p) => p.coin === rejected.coin) || !(pending.get(rejected.coin) ?? Dec.ZERO).isZero) { item.outcome = "already_positioned"; return; }

        const settings = (await this.repository.settingsOf(tx, strategy.id, strategy.version)) as CopyStrategySettings;
        const policy = await this.policies.current(tx);
        const leaderSign: 1 | -1 = szi.isPositive ? 1 : -1;
        const sign = settings.direction === "same" ? leaderSign : (-leaderSign as 1 | -1);
        const equity = strategyValue(strategy, positions, mids).equity;
        const notional = equity === null ? null : openNotional({
          mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional: szi.abs().mul(leaderPx),
          strategyEquity: equity, leaderEquity,
        });
        item.side = sign > 0 ? "B" : "A";
        item.notional = notional === null ? undefined : wire(notional);
        if (options.dryRun) { item.outcome = "would_order"; return; }
        const order = await this.planner.place(tx, {
          strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids, assets,
          coin: rejected.coin, leg: "adopt", side: item.side, notional: notional ?? Dec.ZERO,
          signalPx: mids?.px.get(rejected.coin) ?? leaderPx, signalTime: new Date(), signalTids: [],
          dedupeKey: adoptionRepairKey(strategy.id, rejected.coin),
          rejectReason: notional !== null ? undefined : equity === null ? "no_price" : settings.sizingMode === "ratio" ? "leader_equity_unknown" : "no_per_trade_amount",
        });
        if (!order) return;
        Object.assign(item, { outcome: "ordered", orderId: String(order.id), orderStatus: order.status, orderReason: order.reason, size: wire(order.size) });
      });
    }
    return out;
  }
}
