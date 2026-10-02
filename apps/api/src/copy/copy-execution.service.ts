import { Injectable, Logger, Optional } from "@nestjs/common";
import { COPY_STUCK_ORDER_ATTEMPTS } from "@trading-dashboard/shared/contracts";

import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { NotifyService } from "../notify/notify.service.js";
import { SettingsService } from "../settings/settings.service.js";
import { CopyMarketService, maintenanceMargin, type AssetMap, type Mids } from "./copy-market.service.js";
import { applyFill, cloidOf, dec, fillFees, fundingHours, fundingPayment, roundPx, slippedPx } from "./copy-math.js";
import { pricedCoins } from "./copy-risk.js";
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
 *    authoritative revisions, never a cache — and cancel a risk-increasing
 *    order that any active pause / reduce-only now forbids. Otherwise mark
 *    it `submitting`.
 * 2. Simulated fill: mid now (allMids) ± the policy's slippage, rounded to
 *    the asset's price rules; taker fee from the policy, builder fee from
 *    revenue.builderFeeTenthsBps. Reduce-only orders are clamped to the
 *    strategy's own position and never flip it (`partial` when clamped).
 *    Position, cash, ledger, paper fill and reservation change together.
 *
 * `submitting` exists so that testnet/live can put the exchange round trip
 * between the two; there an unanswered request becomes `unknown` and is
 * reconciled by client order id instead of being re-sent. In paper a
 * leftover `submitting` order is simply re-simulated.
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
    const policy = await this.policies.current();
    const coins = pricedCoins(policy.limits, await this.repository.orderCoins([...stale, ...approved].map((o) => o.id)));
    const mids = await this.market.midPrices(coins);
    const assets = await this.market.assetInfo(coins);
    const builderFeeTenthsBps = (await this.settings.get("revenue")).builderFeeTenthsBps;
    const maxSignalAgeSeconds = policy.limits.maxSignalAgeSeconds;
    const pricing = { mids, assets, slippageBps: policy.limits.simulatedSlippageBps, takerFeeBps: policy.limits.takerFeeBps, builderFeeTenthsBps, maxSignalAgeSeconds };

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
        if (await this.fill(order.id, pricing)) result.filled += 1;
      });
    }
    // A strategy whose leftover order just finished can go on in this pass.
    if (stale.length > 0) approved = await this.repository.approvedOrders(limit);
    for (const order of approved) {
      await guarded(order, async () => {
        const outcome = await this.submit(order.id, maxSignalAgeSeconds);
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

  /** Step 1, the execution boundary. `maxSignalAgeSeconds` defaults to the policy in force. */
  async submit(orderId: bigint, maxSignalAgeSeconds?: number): Promise<"submitting" | "cancelled" | "skipped"> {
    const owner = await this.repository.orderOwner(orderId);
    if (!owner) return "skipped";
    return this.uow.run(async (tx) => {
      // Lock order everywhere: controls (share) → strategy → order.
      const controls = await this.repository.readControls(owner.userId, "share", tx);
      const strategy = await this.repository.lockStrategy(tx, owner.strategyId);
      const peek = await this.repository.lockOrder(tx, orderId);
      if (!strategy || !peek || peek.status !== "risk_approved") return "skipped";
      if (!peek.reduceOnly) {
        const maxAge = maxSignalAgeSeconds ?? (await this.policies.current(tx)).limits.maxSignalAgeSeconds;
        const blocked =
          controls.platform?.pauseNewRisk ? "platform_paused" :
          controls.platform?.reduceOnly ? "platform_reduce_only" :
          controls.user?.pauseNewRisk ? "user_paused" :
          controls.user?.reduceOnly ? "user_reduce_only" :
          strategy.pauseNewRisk ? "strategy_paused" :
          strategy.reduceOnly ? "strategy_reduce_only" :
          strategy.status !== "active" ? `strategy_${strategy.status}` :
          // Approved in time, but it waited: it would fill at a mid the leader never traded at.
          // Adoption is not tied to a fill's price: late is still what the person asked for.
          peek.leg !== "adopt" && signalAgeSeconds(peek) > maxAge ? "stale_signal" : null;
        if (blocked) {
          await this.repository.updateOrder(tx, orderId, { status: "cancelled", reason: `${blocked}_before_submit` });
          await this.repository.settleReservation(tx, orderId, "released");
          return "cancelled";
        }
      }
      await this.repository.updateOrder(tx, orderId, { status: "submitting" });
      return "submitting";
    });
  }

  /** Step 2, the simulated fill of a `submitting` order. */
  async fill(orderId: bigint, pricing: Pricing): Promise<boolean> {
    const owner = await this.repository.orderOwner(orderId);
    if (!owner) return false;
    return this.uow.run(async (tx) => {
      const strategy = await this.repository.lockStrategy(tx, owner.strategyId);
      const order = await this.repository.lockOrder(tx, orderId);
      if (!strategy || !order || order.status !== "submitting") return false;
      const position = await this.repository.lockPosition(tx, strategy.id, order.coin);
      const current = Number(position?.size ?? 0);
      const sign: 1 | -1 = order.side === "B" ? 1 : -1;
      let size = Number(order.size);
      if (order.reduceOnly) {
        // Only the strategy's own position, in the opposite direction, and never past zero.
        if (current === 0 || Math.sign(current) === sign) {
          await this.cancel(tx, order, "reduce_only_no_position");
          return false;
        }
        size = Math.min(size, Math.abs(current));
      } else if (current !== 0 && Math.sign(current) !== sign) {
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
      await this.book(tx, strategy, order, position, size, mid ?? Number(order.signalPx), mid !== undefined ? "mid" : "signal_px", pricing);
      await this.writeOffIfFlat(tx, strategy.id);
      return true;
    });
  }

  /**
   * Books one simulated fill of `size` at `basePx` moved by the policy's
   * slippage: position, strategy cash and totals, paper fill, ledger, the
   * order's final state and its reservation, all in the caller's
   * transaction. Returns the cash change.
   */
  private async book(tx: DbTransaction, strategy: StrategyRow, order: OrderRow, position: PositionRow | undefined, size: number, basePx: number, source: string, pricing: Pricing): Promise<number> {
    const current = Number(position?.size ?? 0);
    const sign: 1 | -1 = order.side === "B" ? 1 : -1;
    const szDecimals = pricing.assets?.get(order.coin)?.szDecimals ?? 0;
    const px = roundPx(slippedPx(basePx, order.side, pricing.slippageBps), szDecimals);
    const notional = size * px;
    const { fee, builderFee } = fillFees(notional, pricing.takerFeeBps, pricing.builderFeeTenthsBps);
    const next = applyFill({ size: current, entryPx: Number(position?.entryPx ?? 0) }, sign, size, px);

    await this.repository.savePosition(tx, strategy.id, order.coin, {
      size: dec(next.size), entryPx: dec(next.entryPx), realizedPnl: dec(next.realizedPnl), opened: current === 0,
    });
    const cashDelta = next.realizedPnl - fee - builderFee;
    await this.repository.addToStrategy(tx, strategy.id, { cash: dec(cashDelta), realizedPnl: dec(next.realizedPnl), fees: dec(fee + builderFee) });
    await this.repository.insertPaperFill(tx, {
      orderId: order.id, strategyId: strategy.id, coin: order.coin, side: order.side, size: dec(size), px: dec(px), basePx: dec(basePx),
      priceSource: source, slippageBps: dec(pricing.slippageBps), fee: dec(fee), builderFee: dec(builderFee), realizedPnl: dec(next.realizedPnl),
    });
    await this.repository.insertLedger(tx, [
      { strategyId: strategy.id, userId: strategy.userId, kind: "realized_pnl", amount: dec(next.realizedPnl), coin: order.coin, orderId: order.id },
      { strategyId: strategy.id, userId: strategy.userId, kind: "fee", amount: dec(-fee), coin: order.coin, orderId: order.id },
      { strategyId: strategy.id, userId: strategy.userId, kind: "builder_fee", amount: dec(-builderFee), coin: order.coin, orderId: order.id },
    ]);
    const partial = size < Number(order.size) - 1e-12;
    await this.repository.updateOrder(tx, order.id, {
      status: partial ? "partial" : "filled", filledSize: dec(size), avgPx: dec(px), fee: dec(fee), builderFee: dec(builderFee),
      reason: partial ? "reduce_only_clamped" : order.reason,
    });
    await this.repository.settleReservation(tx, order.id, "consumed");
    return cashDelta;
  }

  /**
   * A strategy with no position left and cash below zero lost more than it
   * had (a gap the liquidation check could not act inside). The shortfall
   * is written off, so its cash is 0 and what later returns to the paper
   * balance is never negative. Returns the amount written off.
   */
  private async writeOffIfFlat(tx: DbTransaction, strategyId: number): Promise<number> {
    const strategy = await this.repository.lockStrategy(tx, strategyId);
    if (!strategy) return 0;
    const cash = Number(strategy.cash);
    if (!(cash < 0)) return 0;
    if ((await this.repository.positionsOf([strategyId], tx)).length > 0) return 0;
    await this.repository.addToStrategy(tx, strategyId, { cash: dec(-cash) });
    await this.repository.insertLedger(tx, [{ strategyId, userId: strategy.userId, kind: "liquidation", amount: dec(-cash) }]);
    return -cash;
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
      const health = accountHealth(Number(held[0]!.cash), held.map((h) => h.position), mids, assets);
      if (!health || health.equity >= health.maintenance) continue;
      try {
        if (await this.liquidateStrategy(strategyId, mids, assets)) liquidated += 1;
      } catch (error) {
        this.logger.error(`Liquidation of strategy ${strategyId} failed: ${(error as Error).message}`);
      }
    }
    return liquidated;
  }

  /** Liquidates one strategy if, under its lock, it is still below maintenance. */
  private async liquidateStrategy(strategyId: number, mids: Mids, assets: AssetMap): Promise<boolean> {
    const policy = await this.policies.current();
    const builderFeeTenthsBps = (await this.settings.get("revenue")).builderFeeTenthsBps;
    const pricing: Pricing = { mids, assets, slippageBps: policy.limits.simulatedSlippageBps, takerFeeBps: policy.limits.takerFeeBps, builderFeeTenthsBps };
    return this.uow.run(async (tx) => {
      const strategy = await this.repository.lockStrategy(tx, strategyId);
      if (!strategy || strategy.status === "stopped") return false;
      const positions = await this.repository.positionsOf([strategyId], tx);
      const health = accountHealth(Number(strategy.cash), positions, mids, assets);
      if (!health || health.equity >= health.maintenance) return false;
      const reason = `liquidated:equity ${dec(health.equity, 2)} < maintenance ${dec(health.maintenance, 2)}`;
      const cancelledOrders = await this.repository.cancelPending(tx, [strategyId], "liquidated");
      const at = new Date();
      for (const p of positions) {
        const locked = await this.repository.lockPosition(tx, strategyId, p.coin);
        const size = Number(locked?.size ?? 0);
        if (!locked || size === 0) continue;
        const mid = mids.px.get(p.coin)!;
        const order = await this.repository.insertOrder(tx, {
          cloid: cloidOf(`liq:${strategyId}:${p.coin}:${at.getTime()}`), strategyId, userId: strategy.userId, strategyVersion: strategy.version, riskPolicyVersion: policy.version,
          leaderAddress: strategy.leaderAddress, coin: p.coin, leg: "liquidation", side: size > 0 ? "A" : "B", reduceOnly: true, size: dec(Math.abs(size)),
          signalPx: dec(mid), signalTime: at, signalTids: [], status: "submitting", reason, controlRevisions: { platform: 0, user: 0, strategy: strategy.controlRevision + 1 },
        });
        await this.book(tx, strategy, order, locked, Math.abs(size), mid, "liquidation", pricing);
      }
      const writtenOff = await this.writeOffIfFlat(tx, strategyId);
      // Paused: what is left stays in the copy until its owner resumes, adds funds or stops it.
      const paused = await this.repository.updateStrategy(tx, strategyId, {
        pauseNewRisk: true, controlRevision: strategy.controlRevision + 1, ...(strategy.status === "active" ? { status: "paused" as const } : {}),
      });
      await this.repository.insertControlEvent(tx, {
        scope: "strategy", scopeId: strategyId, command: "close_positions", revision: paused.controlRevision, actorUserId: null,
        reason: `liquidation: equity ${dec(health.equity, 2)} below maintenance margin ${dec(health.maintenance, 2)}${writtenOff > 0 ? `; ${dec(writtenOff, 2)} written off` : ""}`,
        result: { cancelledOrders, closeOrders: positions.length },
      });
      this.logger.warn(`Strategy ${strategyId} liquidated (${reason}); ${positions.length} positions closed${writtenOff > 0 ? `, ${dec(writtenOff, 2)} written off` : ""}`);
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
        const strategy = await this.repository.lockStrategy(tx, s.id);
        if (!strategy || strategy.status !== "stopping") return false;
        if ((await this.repository.positionsOf([strategy.id], tx)).length > 0) return false;
        if ((await this.repository.openOrderCount(tx, strategy.id)) > 0) return false;
        // What returns is never negative: a shortfall is written off first.
        const writtenOff = await this.writeOffIfFlat(tx, strategy.id);
        const cash = Number(strategy.cash) + writtenOff;
        await this.repository.lockPaperAccount(tx, strategy.userId, "0");
        await this.repository.adjustPaperBalance(tx, strategy.userId, dec(cash));
        await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId: strategy.userId, kind: "release", amount: dec(-cash) }]);
        await this.repository.updateStrategy(tx, strategy.id, { status: "stopped", stoppedAt: new Date() });
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
      if (!asset || !(asset.markPx > 0)) continue;
      const hours = fundingHours(p.fundingThrough, hour);
      if (hours === 0) continue;
      const amount = fundingPayment(Number(p.size), asset.markPx, asset.funding) * hours;
      const ok = await this.uow.run(async (tx) => {
        const strategy = await this.repository.lockStrategy(tx, p.strategyId);
        if (!strategy) return false;
        if (!(await this.repository.accruePositionFunding(tx, p.strategyId, p.coin, dec(amount), hour))) return false;
        await this.repository.addToStrategy(tx, p.strategyId, { cash: dec(-amount), funding: dec(amount) });
        await this.repository.insertLedger(tx, [{ strategyId: p.strategyId, userId: strategy.userId, kind: "funding", amount: dec(-amount), coin: p.coin }]);
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
export function accountHealth(cash: number, positions: Pick<PositionRow, "coin" | "size" | "entryPx">[], mids: Mids, assets: AssetMap): { equity: number; maintenance: number } | null {
  let equity = cash;
  let maintenance = 0;
  for (const p of positions) {
    const size = Number(p.size);
    if (size === 0) continue;
    const px = mids.px.get(p.coin);
    const asset = assets.get(p.coin);
    if (px === undefined || !asset) return null;
    equity += size * (px - Number(p.entryPx));
    maintenance += maintenanceMargin(size * px, asset.maxLeverage);
  }
  return { equity, maintenance };
}
