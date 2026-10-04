import { Injectable, Logger, Optional } from "@nestjs/common";
import { COPY_STUCK_ORDER_ATTEMPTS, copyStrategySettingsSchema } from "@trading-dashboard/shared/contracts";

import { Dec, type DecInput } from "../common/decimal/dec.js";
import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { NotifyService } from "../notify/notify.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { CopyMarketService, MIDS_TTL_MS, maintenanceMargin, type AssetMap, type Mids } from "./copy-market.service.js";
import { applyFill, cloidOf, dec, fillFees, fundingHours, fundingPayment, roundPx, slippedPx } from "./copy-math.js";
import { evaluateRisk, symbolRefusal } from "./copy-risk.js";
import { strategyValue } from "./copy-planner.service.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository, type OrderRow, type PositionRow, type StrategyRow } from "./copy.repository.js";

/** Orders the executor handles per pass. */
export const EXECUTION_BATCH = 100;
/** A `submitting` order older than this is resumed (crash or restart). */
export const SUBMITTING_RECOVERY_MS = 30_000;

/** Failed execution attempts after which an order is reported: one system
 * message, and a row in /admin/copy until it goes through. */
export const STUCK_ORDER_ATTEMPTS = COPY_STUCK_ORDER_ATTEMPTS;

export interface ExecutionResult {
  filled: number;
  cancelled: number;
}

interface Pricing {
  mids: Mids | null;
  assets: AssetMap | null;
  slippageBps: number;
  takerFeeBps: number;
  builderFeeTenthsBps: number;
  /** A resumed risk-increasing order older than this is cancelled; omitted, no age check. */
  maxSignalAgeSeconds?: number;
}

const signalAgeSeconds = (order: Pick<OrderRow, "signalTime">) => (Date.now() - order.signalTime.getTime()) / 1000;

/**
 * Paper execution. Moves orders through
 * risk_approved → submitting → filled | partial | cancelled, each step its
 * own committed transition:
 *
 * 1. Execution boundary: in one transaction, read the platform and user
 *    control rows (FOR SHARE) and the strategy row (FOR UPDATE) — the
 *    authoritative revisions, never a cache. Recheck current policy,
 *    strategy settings, fresh prices, exposure, equity and reservations;
 *    cancel any risk increase that no longer fits. Otherwise mark it
 *    `submitting` and refresh its own reservation.
 * 2. Simulated fill: mid now (allMids) ± the policy's slippage, rounded to
 *    the asset's price rules; taker fee from the policy, builder fee from
 *    revenue.builderFeeTenthsBps. Reduce-only orders are clamped to the
 *    strategy's own position and never flip it (`partial` when clamped).
 *    Position, cash, ledger, paper fill and reservation change together.
 *
 * `submitting` exists so that testnet/live can put the exchange round trip
 * between the two; there an unanswered request becomes `unknown` and is
 * reconciled by client order id instead of being re-sent. In paper a
 * leftover `submitting` order is revalidated before being re-simulated.
 *
 * Order within a strategy is strict: its orders run in id order, and while
 * one is `submitting` (its fill failed and waits for the retry) nothing
 * later of that strategy runs, so a flip's open never executes before its
 * close. A failure stops only that strategy for the pass; every other
 * strategy's orders still execute. Two more guards at the boundary, for an
 * order that waited (worker downtime, an earlier order that kept failing):
 * a risk-increasing order older than the policy's maxSignalAgeSeconds is
 * cancelled (an adoption leg is not a reaction to a fill and has no age
 * limit), and one that would trade against the strategy's own
 * opposite-signed position is cancelled instead of being booked as a
 * reduction.
 *
 * An order that keeps failing is not silent: every failure is counted on the
 * order with its error; at STUCK_ORDER_ATTEMPTS the operator gets one system
 * message and /admin/copy lists the order until it goes through. It still
 * holds its strategy's later orders (running an open ahead of its failed
 * close would put the copy on the wrong side).
 *
 * Liquidation (review 41). A strategy is its own cross-margin account:
 * equity = cash + unrealized PnL. When equity falls below the maintenance
 * margin of its positions (Hyperliquid's: notional ÷ (2 × the coin's max
 * leverage)), every position is closed at the mid less slippage and fees,
 * pending orders are cancelled, and the strategy is paused. A loss beyond
 * the equity is written off (ledger kind `liquidation`), so cash ends at 0
 * or above and a copy can lose at most what was allocated to it. The same
 * write-off applies whenever a strategy is flat with negative cash, so the
 * paper balance can never be charged for it.
 */
@Injectable()
export class CopyExecutionService {
  private readonly logger = new Logger(CopyExecutionService.name);

  constructor(
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly policies: CopyRiskPolicyService,
    private readonly settings: SettingsService,
    @Optional() private readonly notify?: NotifyService,
  ) {}

  async drain(limit = EXECUTION_BATCH): Promise<ExecutionResult> {
    const result: ExecutionResult = { filled: 0, cancelled: 0 };
    const stale = await this.repository.staleSubmitting(new Date(Date.now() - SUBMITTING_RECOVERY_MS), limit);
    let approved = await this.repository.approvedOrders(limit);
    if (stale.length === 0 && approved.length === 0) return result;
    /** Strategies whose order failed this pass: nothing later of theirs runs before it. */
    const held = new Set<number>();
    const guarded = async (order: { id: bigint; strategyId: number }, work: () => Promise<void>) => {
      if (held.has(order.strategyId)) return;
      try {
        await work();
      } catch (error) {
        held.add(order.strategyId);
        const message = (error as Error).message;
        this.logger.error(`Copy order ${order.id} (strategy ${order.strategyId}) failed; the strategy's later orders wait for it: ${message}`);
        await this.reportFailure(order, message);
      }
    };
    for (const order of stale) {
      await guarded(order, async () => {
        const owner = await this.repository.orderOwner(order.id);
        if (owner && await this.fill(order.id, await this.boundaryPricing(order.id, owner.userId))) result.filled += 1;
      });
    }
    // A strategy whose leftover order just finished can go on in this pass.
    if (stale.length > 0) approved = await this.repository.approvedOrders(limit);
    for (const order of approved) {
      await guarded(order, async () => {
        const owner = await this.repository.orderOwner(order.id);
        if (!owner) return;
        const pricing = await this.boundaryPricing(order.id, owner.userId);
        const outcome = await this.submit(order.id, undefined, pricing);
        if (outcome === "cancelled") result.cancelled += 1;
        else if (outcome === "submitting" && (await this.fill(order.id, pricing))) result.filled += 1;
      });
    }
    return result;
  }

  /** Counts a failed attempt; at STUCK_ORDER_ATTEMPTS tells the operator once. */
  private async reportFailure(order: { id: bigint; strategyId: number }, message: string): Promise<void> {
    try {
      const attempts = await this.repository.recordOrderFailure(order.id, message);
      if (attempts !== STUCK_ORDER_ATTEMPTS) return;
      this.logger.error(`Copy order ${order.id} (strategy ${order.strategyId}) has failed ${attempts} times and is holding its strategy's later orders`);
      await this.notify?.sendSystemMessage(
        `⚠️ Copy order ${order.id} (strategy ${order.strategyId}) has failed ${attempts} times: ${message.slice(0, 200)}. The strategy's later orders wait for it. See /admin/copy.`,
      );
    } catch (error) {
      this.logger.error(`Could not record the failure of copy order ${order.id}: ${(error as Error).message}`);
    }
  }

  /** Market reads happen before locks; state and policy are read again under locks. */
  private async boundaryCoins(userId: number): Promise<string[]> {
    const ids = (await this.repository.liveStrategyIdsOfUser(this.repository.reader, userId)).map((s) => s.id);
    return (await this.repository.positionsOf(ids)).map((p) => p.coin);
  }

  private async boundaryPricing(orderId: bigint, userId: number): Promise<Pricing> {
    const coins = [...await this.repository.orderCoins([orderId]), ...await this.boundaryCoins(userId)];
    const [mids, assets, revenue] = await Promise.all([
      this.market.midPrices(coins), this.market.assetInfo(coins), this.settings.get("revenue"),
    ]);
    // Slippage/fees are replaced with the authoritative policy inside the boundary.
    return { mids, assets, slippageBps: 0, takerFeeBps: 0, builderFeeTenthsBps: revenue.builderFeeTenthsBps };
  }

  /** Step 1, the execution boundary. An optional age bound can only tighten policy. */
  async submit(orderId: bigint, maxSignalAgeSeconds?: number, snapshot?: Pricing): Promise<"submitting" | "cancelled" | "skipped"> {
    const owner = await this.repository.orderOwner(orderId);
    if (!owner) return "skipped";
    const pricing = snapshot ?? await this.boundaryPricing(orderId, owner.userId);
    return this.uow.run(async (tx) => {
      // Policy writers take the exclusive form of this same advisory lock.
      await this.repository.lockPoliciesForExecution(tx);
      await this.repository.lockCopyUser(tx, owner.userId);
      const controls = await this.repository.readControls(owner.userId, "share", tx);
      const strategy = await this.repository.lockStrategy(tx, owner.strategyId);
      const order = await this.repository.lockOrder(tx, orderId);
      if (!strategy || !order || order.status !== "risk_approved") return "skipped";
      const reason = await this.revalidate(tx, strategy, order, controls, pricing, maxSignalAgeSeconds);
      if (reason) {
        await this.cancel(tx, order, `${reason}_before_submit`);
        return "cancelled";
      }
      await this.repository.updateOrder(tx, orderId, { status: "submitting", executionFeeSnapshot: {
        takerFeeBps: pricing.takerFeeBps, builderFeeTenthsBps: pricing.builderFeeTenthsBps,
      } });
      return "submitting";
    });
  }

  /** Check the entire current risk intersection, excluding only this order's reservation.
   * Pending closes do not free exposure until they have actually filled. */
  private async revalidate(
    tx: DbTransaction, strategy: StrategyRow, order: OrderRow,
    controls: Awaited<ReturnType<CopyRepository["readControls"]>>, pricing: Pricing, ageBound?: number,
  ): Promise<string | null> {
    const policy = await this.policies.current(tx);
    pricing.slippageBps = policy.limits.simulatedSlippageBps;
    pricing.takerFeeBps = order.executionFeeSnapshot?.takerFeeBps ?? policy.limits.takerFeeBps;
    pricing.builderFeeTenthsBps = order.executionFeeSnapshot?.builderFeeTenthsBps ?? pricing.builderFeeTenthsBps;
    pricing.maxSignalAgeSeconds = Math.min(policy.limits.maxSignalAgeSeconds, ageBound ?? Infinity);
    await this.repository.updateOrder(tx, order.id, {
      executionPolicyVersion: policy.version, executionStrategyVersion: strategy.version,
      executionControlRevisions: { platform: controls.platform?.revision ?? 0, user: controls.user?.revision ?? 0, strategy: strategy.controlRevision },
    });
    if (order.reduceOnly) return null;
    if (!(await this.repository.userCanCopy(tx, strategy.userId))) return "user_disabled";
    if (policy.invalid) return "risk_policy_invalid";
    if (strategy.status !== "active") return `strategy_${strategy.status}`;
    const refused = symbolRefusal(policy.limits, order.coin);
    if (refused) return refused;
    const parsed = copyStrategySettingsSchema.safeParse(await this.repository.settingsOf(tx, strategy.id, strategy.version));
    if (!parsed.success) return "strategy_settings_invalid";
    const settings = parsed.data;
    let tightenedPerTrade = false;
    if (order.strategyVersion !== strategy.version) {
      const previous = copyStrategySettingsSchema.safeParse(await this.repository.settingsOf(tx, strategy.id, order.strategyVersion));
      if (!previous.success || previous.data.direction !== settings.direction || previous.data.sizingMode !== settings.sizingMode) return "strategy_settings_changed";
      tightenedPerTrade = settings.sizingMode === "fixed" && settings.perTradeUsd !== null &&
        (previous.data.perTradeUsd === null || settings.perTradeUsd < previous.data.perTradeUsd);
    }
    const at = pricing.mids?.at.getTime();
    if (at === undefined || !Number.isFinite(at) || Date.now() - at > MIDS_TTL_MS || at > Date.now()) return "stale_price";
    const mid = pricing.mids?.px.get(order.coin);
    const asset = pricing.assets?.get(order.coin);
    if (!mid?.isPositive) return "no_price";
    if (!asset) return "no_asset_info";
    const positions = await this.repository.positionsOf([strategy.id], tx);
    const current = Dec.from(positions.find((p) => p.coin === order.coin)?.size ?? 0);
    if (!current.isZero && current.sign !== (order.side === "B" ? 1 : -1)) return "opposite_position";
    const userIds = (await this.repository.liveStrategyIdsOfUser(tx, strategy.userId)).map((s) => s.id);
    const userPositions = await this.repository.positionsOf(userIds, tx);
    const reservations = await this.repository.heldReservationRows(userIds, tx);
    // Identity matters: subtracting an estimated notional can free another order's funds.
    const own = reservations.find((r) => r.orderId === order.id);
    if (!own) return "missing_reservation";
    const others = reservations.filter((r) => r.orderId !== order.id);
    let exposure = Dec.ZERO;
    let coinExposure = Dec.ZERO;
    for (const p of userPositions) {
      const px = pricing.mids?.px.get(p.coin);
      if (!px?.isPositive) return "no_price";
      const n = Dec.from(p.size).abs().mul(px);
      exposure = exposure.add(n);
      if (p.coin === order.coin) coinExposure = coinExposure.add(n);
    }
    for (const r of others) {
      exposure = exposure.add(r.notional);
      if (r.coin === order.coin) coinExposure = coinExposure.add(r.notional);
    }
    const value = strategyValue(strategy, positions, pricing.mids);
    if (value.equity === null) return "no_price";
    const px = roundPx(slippedPx(mid, order.side, pricing.slippageBps), asset.szDecimals);
    const size = Dec.from(order.size);
    // Exposure caps value positions at the current mark, regardless of fill slippage.
    const notional = size.mul(mid);
    const fees = fillFees(size.mul(px), pricing.takerFeeBps, pricing.builderFeeTenthsBps);
    const slippageLoss = size.mul(px.sub(mid).abs());
    const reserved = others.filter((r) => r.strategyId === strategy.id);
    if (tightenedPerTrade && settings.perTradeUsd !== null && Dec.from(order.size).mul(mid).gt(settings.perTradeUsd)) return "max_per_trade";
    // The counter already contains this order. Do not charge it twice on revalidation.
    const count = await this.repository.ordersLastMinute(tx, strategy.id);
    const counted = order.leg !== "adopt" && order.createdAt.getTime() >= Date.now() - 60_000;
    const decision = evaluateRisk({
      limits: { ...policy.limits, maxSignalAgeSeconds: pricing.maxSignalAgeSeconds }, settings,
      controls: {
        platform: { pauseNewRisk: controls.platform?.pauseNewRisk ?? false, reduceOnly: controls.platform?.reduceOnly ?? false },
        user: { pauseNewRisk: controls.user?.pauseNewRisk ?? false, reduceOnly: controls.user?.reduceOnly ?? false },
        strategy: { pauseNewRisk: strategy.pauseNewRisk, reduceOnly: strategy.reduceOnly },
      },
      coin: order.coin, increasesRisk: true, adoption: order.leg === "adopt", notional, px: mid,
      signalPx: order.leg === "adopt" ? null : Dec.from(order.signalPx), signalAgeSeconds: signalAgeSeconds(order),
      coinMaxLeverage: asset.maxLeverage,
      strategy: {
        allocated: Dec.from(strategy.allocated), equity: value.equity.sub(fees.fee).sub(fees.builderFee).sub(slippageLoss), exposure: value.exposure,
        reservedMargin: Dec.sum(reserved.map((r) => Dec.from(r.margin))),
        reservedNotional: Dec.sum(reserved.map((r) => Dec.from(r.notional))), ordersLastMinute: Math.max(0, count - (counted ? 1 : 0)),
      },
      user: { coinExposure, exposure },
    });
    if (!decision.ok) return decision.reason;
    // Keep the approved size immutable; a tightened cap requires a new intent.
    if (decision.notional.lt(notional)) return `risk_cap_${decision.notes.join("_")}`;
    await this.repository.refreshHeldReservation(tx, order.id, { notional: notional.toString(), margin: decision.margin.toString() });
    return null;
  }

  /** Step 2, the simulated fill of a `submitting` order. */
  async fill(orderId: bigint, pricing: Pricing): Promise<boolean> {
    const owner = await this.repository.orderOwner(orderId);
    if (!owner) return false;
    return this.uow.run(async (tx) => {
      // Policy writers take the exclusive form of this same advisory lock.
      await this.repository.lockPoliciesForExecution(tx);
      await this.repository.lockCopyUser(tx, owner.userId);
      const controls = await this.repository.readControls(owner.userId, "share", tx);
      const strategy = await this.repository.lockStrategy(tx, owner.strategyId);
      const order = await this.repository.lockOrder(tx, orderId);
      if (!strategy || !order || order.status !== "submitting") return false;
      const reason = await this.revalidate(tx, strategy, order, controls, pricing);
      if (reason) {
        await this.cancel(tx, order, `${reason}_before_fill`);
        return false;
      }
      const position = await this.repository.lockPosition(tx, strategy.id, order.coin);
      const current = Dec.from(position?.size ?? 0);
      const sign: 1 | -1 = order.side === "B" ? 1 : -1;
      let size = Dec.from(order.size);
      if (order.reduceOnly) {
        // Only the strategy's own position, in the opposite direction, and never past zero.
        if (current.isZero || current.sign === sign) {
          await this.cancel(tx, order, "reduce_only_no_position");
          return false;
        }
        size = Dec.min(size, current.abs());
      } else if (!current.isZero && current.sign !== sign) {
        // The close this open follows has not run (it failed, or was
        // cancelled): filling now would be booked as a reduction of the
        // position and leave the copy on the wrong side of the leader.
        await this.cancel(tx, order, "opposite_position");
        return false;
      } else if (order.leg !== "adopt" && pricing.maxSignalAgeSeconds !== undefined && signalAgeSeconds(order) > pricing.maxSignalAgeSeconds) {
        await this.cancel(tx, order, "stale_signal_before_fill");
        return false;
      }
      const mid = pricing.mids?.px.get(order.coin);
      await this.book(tx, strategy, order, position, size, mid ?? Dec.from(order.signalPx), mid !== undefined ? "mid" : "signal_px", pricing);
      await this.writeOffIfFlat(tx, strategy.id);
      return true;
    });
  }

  /**
   * Books one simulated fill of `size` at `basePx` moved by the policy's
   * slippage: position, strategy cash and totals, paper fill, ledger, the
   * order's final state and its reservation, all in the caller's
   * transaction.
   *
   * The realized PnL and the two fees are each quantized once (USD_DP).
   * Those same three values are what the fill row, the three ledger rows,
   * the order and the strategy's totals carry, and the cash moves by their
   * exact sum: cash = Σ ledger, fees = Σ fill fees and realized PnL = Σ fill
   * PnL hold to the last digit, whatever the order of fills.
   */
  private async book(tx: DbTransaction, strategy: StrategyRow, order: OrderRow, position: PositionRow | undefined, size: Dec, basePx: Dec, source: string, pricing: Pricing): Promise<void> {
    const current = Dec.from(position?.size ?? 0);
    const sign: 1 | -1 = order.side === "B" ? 1 : -1;
    const szDecimals = pricing.assets?.get(order.coin)?.szDecimals ?? 0;
    const px = roundPx(slippedPx(basePx, order.side, pricing.slippageBps), szDecimals);
    const notional = size.mul(px);
    const { fee, builderFee } = fillFees(notional, pricing.takerFeeBps, pricing.builderFeeTenthsBps);
    const next = applyFill({ size: current, entryPx: Dec.from(position?.entryPx ?? 0) }, sign, size, px);
    const realized = next.realizedPnl.toString();
    const fees = fee.add(builderFee);

    await this.repository.savePosition(tx, strategy.id, order.coin, {
      size: next.size.toString(), entryPx: next.entryPx.toString(), realizedPnl: realized, opened: current.isZero,
    });
    await this.repository.addToStrategy(tx, strategy.id, { cash: next.realizedPnl.sub(fees).toString(), realizedPnl: realized, fees: fees.toString() });
    await this.repository.insertPaperFill(tx, {
      orderId: order.id, strategyId: strategy.id, coin: order.coin, side: order.side, size: size.toString(), px: px.toString(), basePx: basePx.toString(),
      priceSource: source, slippageBps: dec(pricing.slippageBps), fee: fee.toString(), builderFee: builderFee.toString(), realizedPnl: realized,
    }, { before: current.toString(), after: next.size.toString() });
    await this.repository.insertLedger(tx, [
      { strategyId: strategy.id, userId: strategy.userId, kind: "realized_pnl", amount: realized, coin: order.coin, orderId: order.id },
      { strategyId: strategy.id, userId: strategy.userId, kind: "fee", amount: fee.neg().toString(), coin: order.coin, orderId: order.id },
      { strategyId: strategy.id, userId: strategy.userId, kind: "builder_fee", amount: builderFee.neg().toString(), coin: order.coin, orderId: order.id },
    ]);
    const partial = size.lt(order.size);
    await this.repository.updateOrder(tx, order.id, {
      executionFeeSnapshot: order.executionFeeSnapshot ?? { takerFeeBps: pricing.takerFeeBps, builderFeeTenthsBps: pricing.builderFeeTenthsBps },
      status: partial ? "partial" : "filled", filledSize: size.toString(), avgPx: px.toString(), fee: fee.toString(), builderFee: builderFee.toString(),
      reason: partial ? "reduce_only_clamped" : order.reason,
    });
    await this.repository.settleReservation(tx, order.id, "consumed");
  }

  /**
   * A strategy with no position left and cash below zero lost more than it
   * had (a gap the liquidation check could not act inside). The shortfall
   * is written off, so its cash is 0 and what later returns to the paper
   * balance is never negative. Returns the amount written off.
   */
  private async writeOffIfFlat(tx: DbTransaction, strategyId: number): Promise<Dec> {
    const strategy = await this.repository.lockStrategy(tx, strategyId);
    if (!strategy) return Dec.ZERO;
    const cash = Dec.from(strategy.cash);
    if (!cash.isNegative) return Dec.ZERO;
    if ((await this.repository.positionsOf([strategyId], tx)).length > 0) return Dec.ZERO;
    const shortfall = cash.neg();
    await this.repository.addToStrategy(tx, strategyId, { cash: shortfall.toString() });
    await this.repository.insertLedger(tx, [{ strategyId, userId: strategy.userId, kind: "liquidation", amount: shortfall.toString() }]);
    return shortfall;
  }

  /**
   * The liquidation check, every tick: values every live strategy's open
   * positions at the mids and liquidates those whose equity is below their
   * maintenance margin. A strategy with a position that has no price or no
   * universe entry right now is left for the next tick (never liquidated on
   * missing data). Returns how many strategies were liquidated.
   */
  async liquidate(): Promise<number> {
    const rows = await this.repository.openPositionsOfLive();
    if (rows.length === 0) return 0;
    const coins = [...new Set(rows.map((r) => r.position.coin))];
    const mids = await this.market.midPrices(coins);
    const assets = await this.market.assetInfo(coins);
    if (!mids || !assets) return 0;
    const byStrategy = new Map<number, typeof rows>();
    for (const r of rows) byStrategy.set(r.position.strategyId, [...(byStrategy.get(r.position.strategyId) ?? []), r]);
    let liquidated = 0;
    for (const [strategyId, held] of byStrategy) {
      const health = accountHealth(held[0]!.cash, held.map((h) => h.position), mids, assets);
      if (!health || health.equity.gte(health.maintenance)) continue;
      try {
        if (await this.liquidateStrategy(strategyId, held[0]!.userId, mids, assets)) liquidated += 1;
      } catch (error) {
        this.logger.error(`Liquidation of strategy ${strategyId} failed: ${(error as Error).message}`);
      }
    }
    return liquidated;
  }

  /** Liquidates one strategy if, under its lock, it is still below maintenance. */
  private async liquidateStrategy(strategyId: number, userId: number, mids: Mids, assets: AssetMap): Promise<boolean> {
    const policy = await this.policies.current();
    const builderFeeTenthsBps = (await this.settings.get("revenue")).builderFeeTenthsBps;
    const pricing: Pricing = { mids, assets, slippageBps: policy.limits.simulatedSlippageBps, takerFeeBps: policy.limits.takerFeeBps, builderFeeTenthsBps };
    return this.uow.run(async (tx) => {
      await this.repository.lockCopyUser(tx, userId);
      const strategy = await this.repository.lockStrategy(tx, strategyId);
      if (!strategy || strategy.userId !== userId || strategy.status === "stopped") return false;
      const positions = await this.repository.positionsOf([strategyId], tx);
      const health = accountHealth(strategy.cash, positions, mids, assets);
      if (!health || health.equity.gte(health.maintenance)) return false;
      const reason = `liquidated:equity ${dec(health.equity, 2)} < maintenance ${dec(health.maintenance, 2)}`;
      const cancelledOrders = await this.repository.cancelPending(tx, [strategyId], "liquidated");
      const at = new Date();
      for (const p of positions) {
        const locked = await this.repository.lockPosition(tx, strategyId, p.coin);
        const size = Dec.from(locked?.size ?? 0);
        if (!locked || size.isZero) continue;
        const mid = mids.px.get(p.coin)!;
        const order = await this.repository.insertOrder(tx, {
          cloid: cloidOf(`liq:${strategyId}:${p.coin}:${at.getTime()}`), strategyId, userId: strategy.userId, strategyVersion: strategy.version, riskPolicyVersion: policy.version,
          leaderAddress: strategy.leaderAddress, coin: p.coin, leg: "liquidation", side: size.isPositive ? "A" : "B", reduceOnly: true, size: size.abs().toString(),
          signalPx: mid.toString(), signalTime: at, signalTids: [], status: "submitting", reason, controlRevisions: { platform: 0, user: 0, strategy: strategy.controlRevision + 1 },
        });
        await this.book(tx, strategy, order, locked, size.abs(), mid, "liquidation", pricing);
      }
      const writtenOff = await this.writeOffIfFlat(tx, strategyId);
      // Paused: what is left stays in the copy until its owner resumes, adds funds or stops it.
      const paused = await this.repository.updateStrategy(tx, strategyId, {
        pauseNewRisk: true, controlRevision: strategy.controlRevision + 1, ...(strategy.status === "active" ? { status: "paused" as const } : {}),
      });
      await this.repository.insertControlEvent(tx, {
        scope: "strategy", scopeId: strategyId, command: "close_positions", revision: paused.controlRevision, actorUserId: null,
        reason: `liquidation: equity ${dec(health.equity, 2)} below maintenance margin ${dec(health.maintenance, 2)}${writtenOff.isPositive ? `; ${dec(writtenOff, 2)} written off` : ""}`,
        result: { cancelledOrders, closeOrders: positions.length },
      });
      this.logger.warn(`Strategy ${strategyId} liquidated (${reason}); ${positions.length} positions closed${writtenOff.isPositive ? `, ${dec(writtenOff, 2)} written off` : ""}`);
      return true;
    });
  }

  private async cancel(tx: Parameters<Parameters<UnitOfWork["run"]>[0]>[0], order: OrderRow, reason: string): Promise<void> {
    await this.repository.updateOrder(tx, order.id, { status: "cancelled", reason });
    await this.repository.settleReservation(tx, order.id, "released");
  }

  /**
   * A stopping strategy with no position and no open order is finished: its
   * cash goes back to the paper balance, it becomes `stopped`, and a
   * copy-sourced leader nobody else needs stops being watched.
   */
  async settleStopping(): Promise<number> {
    let settled = 0;
    for (const s of await this.repository.stoppingStrategies()) {
      const done = await this.uow.run(async (tx) => {
        await this.repository.lockCopyUser(tx, s.userId);
        const strategy = await this.repository.lockStrategy(tx, s.id);
        if (!strategy || strategy.userId !== s.userId || strategy.status !== "stopping") return false;
        if ((await this.repository.positionsOf([strategy.id], tx)).length > 0) return false;
        if ((await this.repository.openOrderCount(tx, strategy.id)) > 0) return false;
        // What returns is never negative: a shortfall is written off first.
        const writtenOff = await this.writeOffIfFlat(tx, strategy.id);
        const cash = Dec.from(strategy.cash).add(writtenOff);
        await this.repository.lockPaperAccount(tx, strategy.userId, "0");
        await this.repository.adjustPaperBalance(tx, strategy.userId, cash.toString());
        await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId: strategy.userId, kind: "release", amount: cash.neg().toString() }]);
        const stoppedAt = new Date();
        const netDeposits = Dec.from(strategy.allocated).sub(strategy.withdrawn);
        await this.repository.runtime.snapshot(tx, { strategyId: strategy.id, time: stoppedAt,
          equity: cash.toString(), totalPnl: cash.sub(netDeposits).toString(), netDeposits: netDeposits.toString(), exposureUsd: "0" });
        await this.repository.updateStrategy(tx, strategy.id, { status: "stopped", stoppedAt });
        await this.repository.runtime.appendEvent(tx, strategy.userId, strategy.id, "strategy_stopped", { mode: "paper" });
        await this.repository.unwatchLeaderIfUnused(tx, strategy.leaderAddress);
        return true;
      });
      if (done) settled += 1;
    }
    return settled;
  }

  /**
   * Hourly funding on open paper positions at the current hourly rate and
   * mark (metaAndAssetCtxs): one payment for every hour boundary the
   * position was held across, the first one included (a position opened at
   * 10:30 pays at 11:00). Longs pay when the rate is positive. Missed hours
   * (downtime) are charged at the current rate. Positions without a rate
   * are left for the next pass.
   */
  async accrueFunding(now = new Date()): Promise<number> {
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const due = await this.repository.positionsDueFunding(hour);
    if (due.length === 0) return 0;
    const assets = await this.market.assetInfo(due.map((p) => p.coin));
    if (!assets) return 0;
    let accrued = 0;
    for (const p of due) {
      const asset = assets.get(p.coin);
      if (!asset || !asset.markPx.isPositive) continue;
      const hours = fundingHours(p.fundingThrough, hour);
      if (hours === 0) continue;
      // One USDC amount for the position, the strategy and the ledger.
      const amount = fundingPayment(Dec.from(p.size), asset.markPx, asset.funding, hours).toString();
      const paid = Dec.from(amount).neg().toString();
      const ok = await this.uow.run(async (tx) => {
        const strategy = await this.repository.lockStrategy(tx, p.strategyId);
        if (!strategy) return false;
        if (!(await this.repository.accruePositionFunding(tx, p.strategyId, p.coin, amount, hour))) return false;
        await this.repository.addToStrategy(tx, p.strategyId, { cash: paid, funding: amount });
        await this.repository.insertLedger(tx, [{ strategyId: p.strategyId, userId: strategy.userId, kind: "funding", amount: paid, coin: p.coin }]);
        return true;
      });
      if (ok) accrued += 1;
    }
    return accrued;
  }
}

/** A strategy as a cross-margin account at these mids: its equity and the
 * maintenance margin of its positions. Null when a position can't be valued
 * (no mid, or no universe entry for its max leverage). */
export function accountHealth(cash: DecInput, positions: Pick<PositionRow, "coin" | "size" | "entryPx">[], mids: Mids, assets: AssetMap): { equity: Dec; maintenance: Dec } | null {
  let equity = Dec.from(cash);
  let maintenance = Dec.ZERO;
  for (const p of positions) {
    const size = Dec.from(p.size);
    if (size.isZero) continue;
    const px = mids.px.get(p.coin);
    const asset = assets.get(p.coin);
    if (px === undefined || !asset) return null;
    equity = equity.add(size.mul(px.sub(p.entryPx)));
    maintenance = maintenance.add(maintenanceMargin(size.mul(px), asset.maxLeverage));
  }
  return { equity, maintenance };
}
