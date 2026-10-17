import { Injectable, Logger } from "@nestjs/common";
import type { CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { Dec } from "../common/decimal/dec.js";
import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import type { HlUserFill } from "../hyperliquid/types.js";
import { CopyMarketService, type AssetMap, type LeaderEquity, type Mids } from "./copy-market.service.js";
import { followerSign, legsOf, openNotional, reduceWithCarry, tradeKeyOf, type LeaderFill, type SignalLeg } from "./copy-math.js";
import { CopyOrderPlanner, marketDataGap, strategyValue, type CopyDataGap } from "./copy-planner.service.js";
import { pricedCoins, symbolRefusal } from "./copy-risk.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository, legKey, type OutboxRow, type StrategyRow } from "./copy.repository.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { MAX_SIGNAL_ATTEMPTS, PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT } from '../config/constants/limits.js';
import { LIVE_RISK_LOCK_POLL_MS } from '../config/constants/timings.js';

/** Outbox rows per consumer pass. */
export const SIGNAL_BATCH = 200;

interface DrainResult {
  /** Outbox rows finished this pass. */
  processed: number;
  orders: number;
  /** Rows kept pending because an open couldn't be priced yet. */
  deferred?: number;
  /** Rows whose processing threw this pass (retried with backoff, then parked as `failed`). */
  failed?: number;
}

/** What one pass read upstream before any transaction, shared by its transactions. */
interface SignalContext {
  mids: Mids | null;
  assets: AssetMap | null;
  leaderEquity: LeaderEquity;
  /** When this pass last released each owner's lock (ms since epoch); see {@link CopySignalService.pace}. */
  pacing: Map<number, number>;
}

/** A leg to record: its key in copy_signal_legs and where it came from. */
type LegRef = { tid: bigint; leg: "open" | "close"; coin: string; fillTime: Date };

/** One strategy's pass, planned from unlocked reads: the legs it will record (those not seen
 * yet), grouped into orders exactly as the locked transaction will decide them. */
interface StrategyPlan {
  strategy: StrategyRow;
  settings: CopyStrategySettings;
  /** Fresh legs of fills that could not be classified: recorded as `unclassifiable`. */
  unclassifiable: LegRef[];
  groups: Group[];
  /** Every fresh leg's tid: only legs of an earlier pass can supersede an open of this one. */
  passTids: bigint[];
}

/** Hyperliquid's decimal strings, taken as they are (no float in between). */
function toLeaderFill(f: HlUserFill): LeaderFill {
  return { tid: BigInt(f.tid), coin: f.coin, px: Dec.from(f.px), sz: Dec.from(f.sz), side: f.side, time: f.time, startPosition: Dec.parse(f.startPosition), tradeKey: tradeKeyOf(f) };
}

type Group = { coin: string; leg: "open" | "close"; sign: 1 | -1; tradeKey: string; legs: SignalLeg[] };

/** Consecutive legs of one coin, kind and side form one order. With `perTrade` (fixed sizing)
 * opens also split by leader trade. */
function groupLegs(legs: SignalLeg[], perTrade: boolean): Group[] {
  const out: Group[] = [];
  for (const l of legs) {
    const last = out[out.length - 1];
    if (last && last.coin === l.coin && last.leg === l.leg && last.sign === l.sign && (!perTrade || l.leg !== "open" || last.tradeKey === l.tradeKey)) last.legs.push(l);
    else out.push({ coin: l.coin, leg: l.leg, sign: l.sign, tradeKey: l.tradeKey, legs: [l] });
  }
  return out;
}

const legRef = (l: SignalLeg): LegRef => ({ tid: l.tid, leg: l.leg, coin: l.coin, fillTime: new Date(l.time) });

/**
 * Turns verified leader fills (the execution outbox) into paper orders.
 *
 * Idempotency: each (strategy, tid, leg) is claimed once in copy_signal_legs in the same tx that
 * creates its order; the outbox row is marked done afterwards, so a row seen again finds its
 * legs claimed and changes nothing. Fills run in (time, tid) order, each leg sized from its own
 * startPosition; a late open superseded by a newer fill of the coin is skipped, late reductions
 * still apply. Only fills after the activation cursor count.
 *
 * Missing market data is never a rejection: reductions still go; an open stays pending with
 * backoff, bounded by maxSignalAgeSeconds (then `stale_signal`).
 *
 * Fixed sizing spends once per leader trade (`oid`/`twapId`), later fills → `same_trade` (review 40).
 * A leader's rows are one unit; if it throws they are retried one at a time so only the bad row
 * fails (parked after MAX_SIGNAL_ATTEMPTS) (review 42).
 *
 * Locks (H-R5, gate 12): an owner's copy user lock (7404) is the live order path's lock too. A
 * strategy's pass is planned from unlocked reads (fills, legs already seen, grouping into orders);
 * each locked transaction then records its legs in one insert and decides at most
 * PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT orders (the statement budget), never another owner's work,
 * and the drain leaves a live poll's gap before locking that owner again.
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
    const byAddress = new Map<string, OutboxRow[]>();
    for (const row of pending) byAddress.set(row.address, [...(byAddress.get(row.address) ?? []), row]);
    // Upstream reads happen before the transactions, never inside them.
    const live = await this.repository.liveStrategiesOf([...byAddress.keys()]);
    let mids: Mids | null = null;
    let assets: AssetMap | null = null;
    if (live.length) {
      // Which dexes to price: the coins of these fills and of the positions
      // they may reduce; HIP-3 dexes only while the policy copies them.
      const limits = (await this.policies.current()).limits;
      const coins = new Set(await this.repository.positionCoins(live.map((s) => s.id)));
      for (const [address, rows] of byAddress) for (const f of await this.repository.leaderFills(this.repository.reader, address, rows.map((r) => r.tid))) coins.add(f.coin);
      const priced = pricedCoins(limits, coins);
      mids = await this.market.midPrices(priced);
      assets = await this.market.assetInfo(priced);
    }
    const leaderEquity = new Map<string, LeaderEquity>();
    for (const a of new Set(live.map((s) => s.leaderAddress))) leaderEquity.set(a, await this.market.leaderEquity(a));

    const total = { processed: 0, orders: 0, deferred: 0, failed: 0 };
    const add = (r: { processed: number; orders: number; deferred: number }) => { total.processed += r.processed; total.orders += r.orders; total.deferred += r.deferred; };
    const pacing = new Map<number, number>();
    for (const [address, rows] of byAddress) {
      const ctx: SignalContext = { mids, assets, leaderEquity: leaderEquity.get(address) ?? ({ state: "failed" } as LeaderEquity), pacing };
      try {
        add(await this.processRows(address, rows, ctx));
        continue;
      } catch (error) {
        if (rows.length === 1) {
          await this.fail(rows[0]!, error);
          total.failed += 1;
          continue;
        }
        this.logger.warn(`Copy signals of ${address} failed as a group (${safeErrorText(error)}); retrying its ${rows.length} rows one at a time`);
      }
      // Find the row that fails: each row on its own, in arrival order.
      for (const row of rows) {
        try {
          add(await this.processRows(address, [row], ctx));
        } catch (error) {
          await this.fail(row, error);
          total.failed += 1;
        }
      }
    }
    return { processed: total.processed, orders: total.orders, ...(total.deferred ? { deferred: total.deferred } : {}), ...(total.failed ? { failed: total.failed } : {}) };
  }

  private async fail(row: OutboxRow, error: unknown): Promise<void> {
    const message = (error as Error).message;
    this.logger.error(`Copy signal ${row.id} (${row.address}, tid ${row.tid}) failed: ${safeErrorText(error)}`);
    await this.repository.failOutbox([row.id], message, MAX_SIGNAL_ATTEMPTS);
  }

  /** One leader's rows: the fills and strategies are read and each strategy's pass planned
   * first (no lock); then each strategy's orders are decided in its owner's own short locked
   * transactions (see {@link processGroups}); last, one transaction without any owner lock
   * marks the rows done or deferred and advances the checkpoint. A row is retried
   * (idempotently: its legs are already claimed) if the process stops between the two. */
  private async processRows(address: string, rows: OutboxRow[], ctx: SignalContext): Promise<{ processed: number; orders: number; deferred: number }> {
    const reader = this.repository.reader;
    const raw = await this.repository.leaderFills(reader, address, rows.map((r) => r.tid));
    if (raw.length < rows.length) this.logger.warn(`${rows.length - raw.length} outbox fills of ${address} are not stored; skipped`);
    const fills = raw.map(toLeaderFill).sort((a, b) => a.time - b.time || (a.tid < b.tid ? -1 : a.tid > b.tid ? 1 : 0));
    // One owner's lock per transaction; owners in ascending order, then strategy (a stable order, as before).
    const strategies = (await this.repository.liveStrategiesOf([address])).sort((a, b) => a.userId - b.userId || a.id - b.id);
    /** Fill tids with an open that waits for market data, and for which read. */
    const deferred = new Map<bigint, string>();
    let orders = 0;
    for (const s of strategies) {
      const plan = await this.plan(s, fills);
      if (plan === null) continue;
      // Each locked transaction decides a budget's worth of orders; the first also records the unclassifiable legs.
      for (let from = 0; from < plan.groups.length || (from === 0 && plan.unclassifiable.length); from += PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT) {
        await this.pace(ctx.pacing, s.userId);
        const groups = plan.groups.slice(from, from + PAPER_SIGNAL_GROUPS_PER_LOCK_LIMIT);
        const r = await this.uow.run((tx) => this.processGroups(tx, plan, from === 0 ? plan.unclassifiable : [], groups, ctx));
        ctx.pacing.set(s.userId, Date.now());
        if (r === null) break;
        orders += r.orders;
        for (const [tid, gap] of r.deferred) deferred.set(tid, gap);
      }
    }
    return this.uow.run(async (tx) => {
      const claimed = await this.repository.claimOutbox(tx, rows.map((r) => r.id));
      if (claimed.length === 0) return { processed: 0, orders, deferred: 0 };
      /** Outbox rows that stay pending, with the read they wait for. */
      const waiting = new Map<bigint, string>();
      for (const row of claimed) if (deferred.has(row.tid)) waiting.set(row.id, deferred.get(row.tid)!);
      const done = claimed.filter((row) => !waiting.has(row.id)).map((row) => row.id);
      await this.repository.markOutboxDone(tx, done);
      for (const gap of new Set(waiting.values())) {
        await this.repository.deferOutbox(tx, [...waiting].filter(([, g]) => g === gap).map(([id]) => id), `market_data_unavailable:${gap}`);
      }
      await this.repository.advanceCheckpoint(tx, done.length);
      if (waiting.size) this.logger.warn(`${waiting.size} copy signals of ${address} wait for market data (${[...new Set(waiting.values())].join(", ")})`);
      return { processed: done.length, orders, deferred: waiting.size };
    });
  }

  /** Plans one strategy's pass without a lock: which legs are new, and the orders they group
   * into (the same grouping the locked transaction would make). Null when nothing is new. */
  private async plan(strategy: StrategyRow, fills: LeaderFill[]): Promise<StrategyPlan | null> {
    const reader = this.repository.reader;
    const activated = strategy.activatedAt.getTime();
    const after = fills.filter((f) => f.time > activated); // the activation cursor
    if (after.length === 0) return null;
    const settings = (await this.repository.settingsOf(reader, strategy.id, strategy.version)) as CopyStrategySettings;
    const seen = await this.repository.seenLegs(reader, strategy.id, after.map((f) => f.tid));
    const unclassifiable: LegRef[] = [];
    const legs: SignalLeg[] = [];
    for (const f of after) {
      const fillLegs = legsOf(f);
      if (fillLegs === null) {
        const ref: LegRef = { tid: f.tid, leg: "open", coin: f.coin, fillTime: new Date(f.time) };
        if (!seen.has(legKey(ref))) unclassifiable.push(ref);
        continue;
      }
      for (const l of fillLegs) if (!seen.has(legKey(l))) legs.push(l);
    }
    if (unclassifiable.length === 0 && legs.length === 0) return null;
    return { strategy, settings, unclassifiable, groups: groupLegs(legs, settings.sizingMode === "fixed"), passTids: [...new Set(legs.map((l) => l.tid))] };
  }

  /** A live order of the same owner polls its try-lock every LIVE_RISK_LOCK_POLL_MS for
   * LIVE_RISK_LOCK_WAIT_MS; a blocking re-acquisition right after a commit would always win
   * the lock back first. So between two locked transactions of one owner the drain leaves a
   * gap of at least one poll. */
  private async pace(pacing: Map<number, number>, userId: number): Promise<void> {
    const last = pacing.get(userId);
    if (last === undefined) return;
    const wait = LIVE_RISK_LOCK_POLL_MS - (Date.now() - last);
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }

  /** One locked transaction of a strategy's pass: holds the owner's lock (readControls "share")
   * for PAPER_SIGNAL_LOCK_STATEMENT_BUDGET statements at most — the legs of `groups` recorded in
   * one insert, then each group decided as before. The plan was made from unlocked reads, so the
   * transaction checks it: a strategy changed meanwhile, or a leg recorded meanwhile, throws and
   * the rows are retried (the next pass plans again). Null when the strategy is gone or stopped. */
  private async processGroups(
    tx: DbTransaction, plan: StrategyPlan, unclassifiable: LegRef[], groups: Group[], ctx: SignalContext,
  ): Promise<{ orders: number; deferred: Map<bigint, string> } | null> {
    const policy = await this.policies.current(tx);
    // Lock order: controls (share), then the strategy (update); see CopyControlService.
    const controls = await this.repository.readControls(plan.strategy.userId, "share", tx);
    const strategy = await this.repository.lockStrategy(tx, plan.strategy.id);
    if (!strategy || strategy.status === "stopped") return null;
    if (strategy.version !== plan.strategy.version || strategy.activatedAt.getTime() !== plan.strategy.activatedAt.getTime()) throw new Error("paper_signal_plan_stale:strategy");
    const { settings, passTids } = plan;
    const deferred = new Map<bigint, string>();

    const refs: LegRef[] = [...unclassifiable, ...groups.flatMap((g) => g.legs.map(legRef))];
    const fresh = await this.repository.claimLegs(tx, strategy.id, strategy.version, refs);
    if (fresh.size !== refs.length) throw new Error("paper_signal_plan_stale:legs");
    if (unclassifiable.length) await this.repository.resolveLegs(tx, strategy.id, unclassifiable, "unclassifiable", null);

    let orders = 0;
    for (const g of groups) {
      const tids = g.legs.map((l) => l.tid);
      const refs = g.legs.map((l) => ({ tid: l.tid, leg: l.leg }));
      const first = g.legs[0]!;
      const last = g.legs[g.legs.length - 1]!;
      const sizeSum = Dec.sum(g.legs.map((l) => l.size));
      // The leader's own notional of these fills, and its size-weighted price.
      const leaderNotional = Dec.sum(g.legs.map((l) => l.size.mul(l.px)));
      const signalPx = leaderNotional.div(sizeSum);
      const fSign = followerSign(g.sign, settings.direction);
      const pending = await this.repository.pendingSizes(tx, strategy.id);
      const [position] = (await this.repository.positionsOf([strategy.id], tx)).filter((p) => p.coin === g.coin);
      const current = Dec.from(position?.size ?? 0).add(pending.get(g.coin) ?? Dec.ZERO);
      const dedupeKey = `${strategy.id}:${first.tid}:${g.leg}:v${strategy.version}`;

      if (g.leg === "open") {
        // Only legs handled by an earlier pass can supersede: this pass runs in time order.
        if (await this.repository.hasNewerLeg(tx, strategy.id, g.coin, new Date(first.time), passTids)) {
          await this.repository.resolveLegs(tx, strategy.id, refs, "superseded", null);
          continue;
        }
        if (!current.isZero && current.sign !== fSign) {
          await this.repository.resolveLegs(tx, strategy.id, refs, "opposite_position", null);
          continue;
        }
        // Fixed sizing: an earlier fill of this leader trade already placed its order.
        if (settings.sizingMode === "fixed" && (await this.repository.tradeAlreadyOrdered(tx, strategy.id, g.tradeKey))) {
          await this.repository.resolveLegs(tx, strategy.id, refs, "same_trade", null);
          continue;
        }
        const age = (Date.now() - last.time) / 1000;
        // A failed leader-equity read is a gap like the mids, not "the leader has nothing".
        // A market the policy never copies does not wait: it is refused.
        const gap: CopyDataGap | null = strategy.status === "active" && !policy.invalid && symbolRefusal(policy.limits, g.coin) === null
          ? (marketDataGap(ctx.mids, ctx.assets, g.coin) ?? (settings.sizingMode === "ratio" && ctx.leaderEquity.state === "failed" ? "leader_equity" : null))
          : null;
        if (gap && age <= policy.limits.maxSignalAgeSeconds) {
          // Not decidable yet: give the legs back so the retry sees them as new.
          await this.repository.releaseLegs(tx, strategy.id, refs);
          for (const tid of tids) deferred.set(tid, gap);
          continue;
        }
        const positions = await this.repository.positionsOf([strategy.id], tx);
        const value = strategyValue(strategy, positions, ctx.mids);
        const notional = openNotional({ mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional, strategyEquity: value.equity ?? Dec.ZERO, leaderEquity: ctx.leaderEquity.state === "known" ? ctx.leaderEquity.value : null });
        const order = await this.planner.place(tx, {
          strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids: ctx.mids, assets: ctx.assets,
          coin: g.coin, leg: "open", side: fSign > 0 ? "B" : "A", notional: notional ?? Dec.ZERO,
          signalPx, signalTime: new Date(last.time), signalTids: tids, dedupeKey, tradeKey: g.tradeKey,
          rejectReason:
            policy.invalid ? "risk_policy_invalid" :
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
      if (current.isZero || current.sign !== fSign) {
        await this.repository.resolveLegs(tx, strategy.id, refs, "nothing_to_reduce", null);
        continue;
      }
      const remaining = g.legs.reduce((keep, l) => (l.leg === "close" ? keep.mul(Dec.ONE.sub(l.fraction)) : keep), Dec.ONE);
      // Lot-rounding remainder carries to the next reduction, never dropped.
      const reduction = reduceWithCarry(current.abs(), Dec.ONE.sub(remaining), Dec.from(position?.reduceCarry ?? 0), ctx.assets?.get(g.coin)?.szDecimals ?? null);
      // The carry is a size the lot rule could not express: kept at full precision.
      if (position) await this.repository.setReduceCarry(tx, strategy.id, g.coin, reduction.carry.toString());
      const size = reduction.size;
      if (!size.isPositive) {
        await this.repository.resolveLegs(tx, strategy.id, refs, "below_lot_carried", null);
        continue;
      }
      const order = await this.planner.place(tx, {
        strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids: ctx.mids, assets: ctx.assets,
        coin: g.coin, leg: "close", side: fSign > 0 ? "A" : "B", size,
        signalPx, signalTime: new Date(last.time), signalTids: tids, dedupeKey,
      });
      await this.repository.resolveLegs(tx, strategy.id, refs, order ? "ordered" : "nothing_to_reduce", order?.id ?? null);
      if (order) orders += 1;
    }
    return { orders, deferred };
  }
}
