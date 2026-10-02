import { Injectable, Logger } from "@nestjs/common";

import { UnitOfWork } from "../db/unit-of-work.js";
import { SettingsService } from "../settings/settings.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { applyFill, dec, fillFees, fundingPayment, roundPx, slippedPx } from "./copy-math.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository, type OrderRow } from "./copy.repository.js";

/** Orders the executor handles per pass. */
export const EXECUTION_BATCH = 100;
/** A `submitting` order older than this is resumed (crash or restart). */
export const SUBMITTING_RECOVERY_MS = 30_000;

export interface ExecutionResult {
  filled: number;
  cancelled: number;
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
 * cancelled, and one that would trade against the strategy's own
 * opposite-signed position is cancelled instead of being booked as a
 * reduction.
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
  ) {}

  async drain(limit = EXECUTION_BATCH): Promise<ExecutionResult> {
    const result: ExecutionResult = { filled: 0, cancelled: 0 };
    const stale = await this.repository.staleSubmitting(new Date(Date.now() - SUBMITTING_RECOVERY_MS), limit);
    let approved = await this.repository.approvedOrders(limit);
    if (stale.length === 0 && approved.length === 0) return result;
    const mids = await this.market.midPrices();
    const assets = await this.market.assetInfo();
    const policy = await this.policies.current();
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
        this.logger.error(`Copy order ${order.id} (strategy ${order.strategyId}) failed; the strategy's later orders wait for it: ${(error as Error).message}`);
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
          signalAgeSeconds(peek) > maxAge ? "stale_signal" : null;
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
  async fill(orderId: bigint, pricing: {
    mids: Awaited<ReturnType<CopyMarketService["midPrices"]>>;
    assets: Awaited<ReturnType<CopyMarketService["assetInfo"]>>;
    slippageBps: number;
    takerFeeBps: number;
    builderFeeTenthsBps: number;
    /** A resumed risk-increasing order older than this is cancelled; omitted, no age check. */
    maxSignalAgeSeconds?: number;
  }): Promise<boolean> {
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
      } else if (pricing.maxSignalAgeSeconds !== undefined && signalAgeSeconds(order) > pricing.maxSignalAgeSeconds) {
        await this.cancel(tx, order, "stale_signal_before_fill");
        return false;
      }
      const mid = pricing.mids?.px.get(order.coin);
      const basePx = mid ?? Number(order.signalPx);
      const source = mid !== undefined ? "mid" : "signal_px";
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
        await this.repository.lockPaperAccount(tx, strategy.userId, "0");
        await this.repository.adjustPaperBalance(tx, strategy.userId, strategy.cash);
        await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId: strategy.userId, kind: "release", amount: dec(-Number(strategy.cash)) }]);
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
   * mark (metaAndAssetCtxs), once per whole hour per position: longs pay
   * when the rate is positive. Missed hours (downtime) are charged at the
   * current rate. Positions without a rate are left for the next pass.
   */
  async accrueFunding(now = new Date()): Promise<number> {
    const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
    const due = await this.repository.positionsDueFunding(hour);
    if (due.length === 0) return 0;
    const assets = await this.market.assetInfo();
    if (!assets) return 0;
    let accrued = 0;
    for (const p of due) {
      const asset = assets.get(p.coin);
      if (!asset || !(asset.markPx > 0)) continue;
      const hours = Math.max(0, Math.floor((hour.getTime() - p.fundingThrough.getTime()) / 3_600_000));
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
