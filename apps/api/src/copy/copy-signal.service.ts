import { Injectable, Logger } from "@nestjs/common";
import type { CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { CopyMarketService, type AssetInfo, type Mids } from "./copy-market.service.js";
import { followerSign, legsOf, openNotional, reduceSize, type LeaderFill, type SignalLeg } from "./copy-math.js";
import { CopyOrderPlanner, marketDataGap, strategyValue } from "./copy-planner.service.js";
import { CopyRiskPolicyService, type PolicyRead } from "./copy-risk-policy.service.js";
import { CopyRepository, type OutboxRow } from "./copy.repository.js";

/** Outbox rows per consumer pass. */
export const SIGNAL_BATCH = 200;
/** Attempts before an outbox row is parked as `failed` (visible in admin). */
export const MAX_SIGNAL_ATTEMPTS = 8;

export interface DrainResult {
  /** Outbox rows finished this pass. */
  processed: number;
  orders: number;
  /** Rows kept pending because an open couldn't be priced yet. */
  deferred?: number;
}

function toLeaderFill(f: HlUserFill): LeaderFill {
  const start = f.startPosition === undefined ? null : Number(f.startPosition);
  return { tid: BigInt(f.tid), coin: f.coin, px: Number(f.px), sz: Number(f.sz), side: f.side, time: f.time, startPosition: start !== null && Number.isFinite(start) ? start : null };
}

type Group = { coin: string; leg: "open" | "close"; sign: 1 | -1; legs: SignalLeg[] };

/** Consecutive legs of one coin, kind and side form one order (the fills of
 * one leader order usually arrive together); anything in between splits them. */
function groupLegs(legs: SignalLeg[]): Group[] {
  const out: Group[] = [];
  for (const l of legs) {
    const last = out[out.length - 1];
    if (last && last.coin === l.coin && last.leg === l.leg && last.sign === l.sign) last.legs.push(l);
    else out.push({ coin: l.coin, leg: l.leg, sign: l.sign, legs: [l] });
  }
  return out;
}

/**
 * The copy-execution consumer: turns verified leader fills (the execution
 * outbox) into paper orders. Never reads the notification `actions` or their
 * outbox.
 *
 * Idempotency: every (strategy, fill tid, leg) is claimed once in
 * copy_signal_legs, in the same transaction that creates its order and marks
 * the outbox row done, so a replayed, duplicated or re-enqueued fill can't
 * trade twice, and a crash before commit leaves the row pending for the next
 * pass (restart resumes from the checkpoint). Fills are processed in
 * (time, tid) order; each leg is sized from the fill's own startPosition, so
 * arrival order does not change what a leg means. A late open that a newer
 * processed fill of the same coin supersedes is skipped; late reductions
 * still apply. Only fills after a strategy's activation cursor count.
 *
 * Market data that failed to load (mids or the universe: a Hyperliquid
 * timeout, a starved budget) is not a reason to reject. In such a pass
 * reductions are still placed (they need no price to be approved); an open
 * is left unclaimed and its outbox row stays pending with a short backoff,
 * so the next pass decides it with real prices. The wait is bounded by the
 * policy's maxSignalAgeSeconds: an open older than that is rejected as
 * `stale_signal`, with or without data.
 */
@Injectable()
export class CopySignalService {
  private readonly logger = new Logger(CopySignalService.name);

  constructor(
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly planner: CopyOrderPlanner,
    private readonly policies: CopyRiskPolicyService,
  ) {}

  async drain(limit = SIGNAL_BATCH): Promise<DrainResult> {
    const pending = await this.repository.pendingOutbox(limit);
    if (pending.length === 0) return { processed: 0, orders: 0 };
    const addresses = [...new Set(pending.map((r) => r.address))];
    // Upstream reads happen before the transaction, never inside it.
    const live = await this.repository.liveStrategiesOf(addresses);
    const mids = live.length ? await this.market.midPrices() : null;
    const assets = live.length ? await this.market.assetInfo() : null;
    const leaderEquity = new Map<string, number | null>();
    for (const a of new Set(live.map((s) => s.leaderAddress))) leaderEquity.set(a, await this.market.leaderEquity(a));

    const ids = pending.map((r) => r.id);
    try {
      return await this.uow.run(async (tx) => {
        const claimed = await this.repository.claimOutbox(tx, ids);
        if (claimed.length === 0) return { processed: 0, orders: 0 };
        const policy = await this.policies.current(tx);
        let orders = 0;
        /** Outbox rows that stay pending, with the read they wait for. */
        const waiting = new Map<bigint, string>();
        const byAddress = new Map<string, OutboxRow[]>();
        for (const row of claimed) byAddress.set(row.address, [...(byAddress.get(row.address) ?? []), row]);
        for (const [address, rows] of byAddress) {
          const r = await this.processLeader(tx, address, rows, { mids, assets, policy, leaderEquity: leaderEquity.get(address) ?? null });
          orders += r.orders;
          for (const row of rows) if (r.deferred.has(row.tid)) waiting.set(row.id, r.deferred.get(row.tid)!);
        }
        const done = claimed.filter((r) => !waiting.has(r.id)).map((r) => r.id);
        await this.repository.markOutboxDone(tx, done);
        for (const gap of new Set(waiting.values())) {
          await this.repository.deferOutbox(tx, [...waiting].filter(([, g]) => g === gap).map(([id]) => id), `market_data_unavailable:${gap}`);
        }
        await this.repository.advanceCheckpoint(tx, done.length);
        if (waiting.size) this.logger.warn(`${waiting.size} copy signals wait for market data (${[...new Set(waiting.values())].join(", ")})`);
        return waiting.size ? { processed: done.length, orders, deferred: waiting.size } : { processed: done.length, orders };
      });
    } catch (error) {
      const message = (error as Error).message;
      this.logger.error(`Copy signal batch failed (${ids.length} rows): ${message}`);
      await this.repository.failOutbox(ids, message, MAX_SIGNAL_ATTEMPTS);
      return { processed: 0, orders: 0 };
    }
  }

  private async processLeader(
    tx: DbTransaction,
    address: string,
    rows: OutboxRow[],
    ctx: { mids: Mids | null; assets: Map<string, AssetInfo> | null; policy: PolicyRead; leaderEquity: number | null },
  ): Promise<{ orders: number; deferred: Map<bigint, string> }> {
    /** Fill tids with an open that waits for market data, and for which read. */
    const deferred = new Map<bigint, string>();
    const raw = await this.repository.leaderFills(tx, address, rows.map((r) => r.tid));
    if (raw.length < rows.length) this.logger.warn(`${rows.length - raw.length} outbox fills of ${address} are not stored; skipped`);
    const fills = raw.map(toLeaderFill).sort((a, b) => a.time - b.time || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0));
    const strategies = await this.repository.liveStrategiesOf([address], tx);
    let orders = 0;
    for (const s of strategies) {
      // Lock order: controls (share), then the strategy (update); see CopyControlService.
      const controls = await this.repository.readControls(s.userId, "share", tx);
      const strategy = await this.repository.lockStrategy(tx, s.id);
      if (!strategy || strategy.status === "stopped") continue;
      const settings = (await this.repository.settingsOf(tx, strategy.id, strategy.version)) as CopyStrategySettings;
      const activated = strategy.activatedAt.getTime();

      const legs: SignalLeg[] = [];
      for (const f of fills) {
        if (f.time <= activated) continue; // before the activation cursor
        const fillLegs = legsOf(f);
        if (fillLegs === null) {
          if (await this.repository.claimLeg(tx, { strategyId: strategy.id, tid: f.tid, leg: "open", strategyVersion: strategy.version, coin: f.coin, fillTime: new Date(f.time) })) {
            await this.repository.resolveLegs(tx, strategy.id, [{ tid: f.tid, leg: "open" }], "unclassifiable", null);
          }
          continue;
        }
        for (const l of fillLegs) {
          const fresh = await this.repository.claimLeg(tx, { strategyId: strategy.id, tid: l.tid, leg: l.leg, strategyVersion: strategy.version, coin: l.coin, fillTime: new Date(l.time) });
          if (fresh) legs.push(l);
        }
      }

      const passTids = [...new Set(legs.map((l) => l.tid))];
      for (const g of groupLegs(legs)) {
        const tids = g.legs.map((l) => l.tid);
        const refs = g.legs.map((l) => ({ tid: l.tid, leg: l.leg }));
        const first = g.legs[0]!;
        const last = g.legs[g.legs.length - 1]!;
        const sizeSum = g.legs.reduce((a, l) => a + l.size, 0);
        const signalPx = g.legs.reduce((a, l) => a + l.size * l.px, 0) / sizeSum;
        const fSign = followerSign(g.sign, settings.direction);
        const pending = await this.repository.pendingSizes(tx, strategy.id);
        const [position] = (await this.repository.positionsOf([strategy.id], tx)).filter((p) => p.coin === g.coin);
        const current = Number(position?.size ?? 0) + (pending.get(g.coin) ?? 0);
        const dedupeKey = `${strategy.id}:${first.tid}:${g.leg}:v${strategy.version}`;

        if (g.leg === "open") {
          // Only legs handled by an earlier pass can supersede: this pass runs in time order.
          if (await this.repository.hasNewerLeg(tx, strategy.id, g.coin, new Date(first.time), passTids)) {
            await this.repository.resolveLegs(tx, strategy.id, refs, "superseded", null);
            continue;
          }
          if (current !== 0 && Math.sign(current) !== fSign) {
            await this.repository.resolveLegs(tx, strategy.id, refs, "opposite_position", null);
            continue;
          }
          const age = (Date.now() - last.time) / 1000;
          const gap = strategy.status === "active" && !ctx.policy.invalid ? marketDataGap(ctx.mids, ctx.assets, g.coin) : null;
          if (gap && age <= ctx.policy.limits.maxSignalAgeSeconds) {
            // Not decidable yet: give the legs back so the retry sees them as new.
            await this.repository.releaseLegs(tx, strategy.id, refs);
            for (const tid of tids) deferred.set(tid, gap);
            continue;
          }
          const positions = await this.repository.positionsOf([strategy.id], tx);
          const value = strategyValue(strategy, positions, ctx.mids);
          const notional = openNotional({ mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional: sizeSum * signalPx, strategyEquity: value.equity ?? 0, leaderEquity: ctx.leaderEquity });
          const order = await this.planner.place(tx, {
            strategy, settings, policy: ctx.policy, controls: { platform: controls.platform, user: controls.user }, mids: ctx.mids, assets: ctx.assets,
            coin: g.coin, leg: "open", side: fSign > 0 ? "B" : "A", notional: notional ?? 0,
            signalPx, signalTime: new Date(last.time), signalTids: tids, dedupeKey,
            rejectReason:
              ctx.policy.invalid ? "risk_policy_invalid" :
              // The planner refuses a copy that isn't active, with that reason.
              strategy.status !== "active" ? undefined :
              // Waited for data past the signal-age limit: the same refusal as any late open.
              gap ? "stale_signal" :
              notional !== null ? undefined :
              settings.sizingMode !== "ratio" ? "no_per_trade_amount" :
              // The mids were read and an open position has none: not the leader's equity.
              value.equity === null ? "no_price" : "leader_equity_unknown",
          });
          await this.repository.resolveLegs(tx, strategy.id, refs, order ? (order.status === "rejected" ? `rejected:${order.reason}` : "ordered") : "none", order?.id ?? null);
          if (order) orders += 1;
          continue;
        }

        // close: reduce the follower's own position by the same fraction(s).
        if (current === 0 || Math.sign(current) !== fSign) {
          await this.repository.resolveLegs(tx, strategy.id, refs, "nothing_to_reduce", null);
          continue;
        }
        const remaining = g.legs.reduce((keep, l) => keep * (1 - (l.leg === "close" ? l.fraction : 0)), 1);
        const size = remaining <= 1e-9 ? Math.abs(current) : reduceSize(Math.abs(current), 1 - remaining);
        const order = await this.planner.place(tx, {
          strategy, settings, policy: ctx.policy, controls: { platform: controls.platform, user: controls.user }, mids: ctx.mids, assets: ctx.assets,
          coin: g.coin, leg: "close", side: fSign > 0 ? "A" : "B", size,
          signalPx, signalTime: new Date(last.time), signalTids: tids, dedupeKey,
        });
        await this.repository.resolveLegs(tx, strategy.id, refs, order ? "ordered" : "nothing_to_reduce", order?.id ?? null);
        if (order) orders += 1;
      }
    }
    return { orders, deferred };
  }
}
