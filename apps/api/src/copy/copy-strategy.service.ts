import { WatchCapacityError } from "../watcher/leader-watch.js";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  addCopyFundsRequestSchema,
  withdrawCopyFundsRequestSchema,
  copyStrategyCommandRequestSchema,
  copyOrdersQuerySchema,
  createCopyStrategyRequestSchema,
  patchCopyStrategyRequestSchema,
  type CopyAdoption,
  type CopyOrdersResponse,
  type CopyLedgerResponse,
  type CopyFillsResponse,
  type CopyOverviewResponse,
  type CopyStrategy,
  type CopyStrategyCommand,
  type CopyStrategySettings,
} from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { parseOr400 } from "../common/http/validation.js";
import { Dec } from "../common/decimal/dec.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { SettingsService } from "../settings/settings.service.js";
import { CopyControlService } from "./copy-control.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { freeCopyCollateral } from "./copy-collateral.js";
import { dec, leaderPositionPx, openNotional } from "./copy-math.js";
import { toCopyOrder, toCopyStrategy, wire } from "./copy.mappers.js";
import { CopyOrderPlanner, marketDataGap } from "./copy-planner.service.js";
import { pricedCoins, symbolRefusal } from "./copy-risk.js";
import { CopyRiskPolicyService } from "./copy-risk-policy.service.js";
import { CopyRepository } from "./copy.repository.js";

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, code, message, ...extra });

/**
 * The signed-in user's paper copies: start (CopyDog's configure), edit
 * (a new immutable version), add funds, commands, and the portfolio read.
 * Paper money only: the virtual balance in paper_accounts, never the
 * user's wallet.
 */
@Injectable()
export class CopyStrategyService {
  private readonly logger = new Logger(CopyStrategyService.name);

  constructor(
    private readonly config: AppConfig,
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly planner: CopyOrderPlanner,
    private readonly policies: CopyRiskPolicyService,
    private readonly controls: CopyControlService,
    private readonly site: SettingsService,
  ) {}

  private requireEnabled(): void {
    if (this.config.value.copy.mode === "disabled") throw new ServiceUnavailableException({ statusCode: 503, code: "copy_disabled", message: "Copy trading is off on this deployment" });
  }

  /** GET /me/copy. Creates the paper account on first read. */
  async overview(userId: number): Promise<CopyOverviewResponse> {
    const policy = await this.policies.current();
    const [account, controls] = await this.uow.run(async (tx) => [
      await this.repository.lockPaperAccount(tx, userId, dec(policy.limits.paperStartingBalanceUsd)),
      await this.repository.readControls(userId, "none", tx),
    ] as const);
    const rows = await this.repository.strategiesOfUser(userId);
    const ids = rows.map((r) => r.strategy.id);
    const [positions, counts, reservations] = await Promise.all([this.repository.positionsOf(ids), this.repository.orderCounts(ids), this.repository.heldReservations(ids)]);
    const mids = positions.length ? await this.market.midPrices(positions.map((p) => p.coin)) : null;
    const assets = positions.length ? await this.market.assetInfo(positions.map((p) => p.coin)) : null;
    const strategies = rows.map((r) => {
      const settings = r.settings as CopyStrategySettings;
      const free = policy.invalid || r.strategy.status === "stopped" || r.strategy.status === "stopping" ? null
        : freeCopyCollateral(r.strategy, settings, positions.filter((p) => p.strategyId === r.strategy.id), reservations.filter((p) => p.strategyId === r.strategy.id), policy.limits, mids, assets);
      return { ...toCopyStrategy(r.strategy, settings, positions, mids, counts.get(r.strategy.id)), freeCollateralUsd: free === null ? null : wire(free) };
    });
    const live = strategies.filter((s) => s.status !== "stopped");
    // Totals are summed from the stored decimals, not from the display numbers.
    const liveRows = rows.filter((r) => r.strategy.status !== "stopped").map((r) => r.strategy);
    const priced = live.every((s) => s.equity !== null);
    const liveEquity = priced
      ? Dec.sum(liveRows.map((s) => Dec.from(s.cash).add(Dec.sum(positions.filter((p) => p.strategyId === s.id).map((p) => Dec.from(p.size).mul(mids!.px.get(p.coin)!.sub(p.entryPx)))))))
      : null;
    const balance = Dec.from(account.balance);
    const totalValue = liveEquity === null ? null : balance.add(liveEquity);
    const startingBalance = Dec.from(account.startingBalance);
    return {
      mode: "paper",
      paper: {
        balance: wire(balance),
        startingBalance: wire(startingBalance),
        allocated: wire(Dec.sum(liveRows.map((s) => Dec.from(s.allocated)))),
        totalValue: totalValue === null ? null : wire(totalValue),
        totalPnl: totalValue === null ? null : wire(totalValue.sub(startingBalance)),
      },
      limits: { minAllocationUsd: policy.limits.minAllocationUsd, maxAllocationUsd: policy.limits.maxAllocationUsd, maxStrategies: policy.limits.maxStrategiesPerUser },
      platform: { pauseNewRisk: controls.platform?.pauseNewRisk ?? false, reduceOnly: controls.platform?.reduceOnly ?? false, revision: controls.platform?.revision ?? 0 },
      user: { pauseNewRisk: controls.user?.pauseNewRisk ?? false, reduceOnly: controls.user?.reduceOnly ?? false, revision: controls.user?.revision ?? 0 },
      strategies,
      pricedAt: mids?.at ?? null,
    };
  }

  /**
   * POST /me/copy/strategies. With copyStartMode `adopt` (CopyDog's 跟單目前持倉,
   * on by default) the leader is read first and the activation cursor is
   * that snapshot's time: the positions it shows are adopted, and only fills
   * after it are copied, so nothing is counted twice. With `delta` the
   * cursor is now. 403 copy_not_open while the admin's
   * `general.copyTradingEnabled` is off: no new copy starts; copies already
   * running, and their pause, resume, edit and stop, are untouched (the
   * admin copy commands are what stops those). 409: already_copying, insufficient_balance,
   * copy_paused (platform or user stop), strategy_limit. 503
   * leader_unavailable when the leader, the mids or the universe can't be
   * read while there are positions to adopt: nothing is created.
   *
   * Adoption is not cut short (review 39): its legs have no signal age and
   * are not counted by the per-minute order cap, so a leader with fifty
   * positions is adopted whole, within the exposure and funds caps. The
   * leader's builder-dex (HIP-3) positions are read as well: adopted when
   * the policy's `allowHip3` is on, listed as `symbol_not_allowed` when it
   * is off. The answer's `adoption` lists every position the leader held
   * and whether it was adopted, with the reason when not.
   */
  async create(userId: number, input: unknown): Promise<CopyStrategy> {
    this.requireEnabled();
    if (!(await this.site.get("general")).copyTradingEnabled) {
      throw new ForbiddenException({ statusCode: 403, code: "copy_not_open", message: "Copy trading is not open" });
    }
    const req = parseOr400(createCopyStrategyRequestSchema, input);
    if (req.sizingMode === "fixed" && req.perTradeUsd === null) throw new BadRequestException({ statusCode: 400, code: "per_trade_required", message: "Fixed sizing needs an amount per trade" });
    const settings: CopyStrategySettings = {
      direction: req.direction, sizingMode: req.sizingMode, perTradeUsd: req.perTradeUsd,
      maxTotalExposureUsd: req.maxTotalExposureUsd, maxLeverage: req.maxLeverage, copyStartMode: req.copyStartMode,
    };
    const limitsNow = (await this.policies.current()).limits;
    let snapshot: Awaited<ReturnType<CopyMarketService["leaderSnapshot"]>> | null = null;
    if (req.copyStartMode === "adopt") {
      try {
        snapshot = await this.market.leaderSnapshot(req.leader);
      } catch (error) {
        this.logger.warn(`Leader snapshot for ${req.leader} failed: ${(error as Error).message}`);
        throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Couldn't read the trader's positions; try again" });
      }
    }
    const held = (snapshot?.assetPositions ?? []).filter((ap) => { const szi = Dec.parse(ap.position.szi); return szi !== null && !szi.isZero; });
    // Markets the policy never copies are refused without data and are not read.
    const adoptable = pricedCoins(limitsNow, held.map((ap) => ap.position.coin)).filter((coin) => symbolRefusal(limitsNow, coin) === null);
    const mids = adoptable.length ? await this.market.midPrices(adoptable) : null;
    const assets = adoptable.length ? await this.market.assetInfo(adoptable) : null;
    // Adoption is all-or-nothing on market data: without mids or the
    // universe no adoption order can be sized, and a copy that started
    // without the leader's positions would stay wrong until the leader
    // trades again. Nothing is created; the person retries (the web shows
    // this code as a toast).
    const gap = adoptable.map((coin) => marketDataGap(mids, assets, coin)).find((g) => g !== null);
    if (gap) {
      this.logger.warn(`Copy of ${req.leader} not started: ${gap} unavailable for adoption`);
      throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Market data is unavailable, so the trader's positions can't be copied right now; try again" });
    }

    // Ratio sizing divides by the leader's whole account value. A read of
    // it that failed is the same case as missing market data: start nothing.
    const equity = adoptable.length && settings.sizingMode === "ratio" ? await this.market.leaderEquity(req.leader) : null;
    if (equity?.state === "failed") {
      throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Couldn't read the trader's account value; try again" });
    }
    const leaderEquity = equity?.state === "known" ? equity.value : null;

    const adoption: CopyAdoption[] = [];
    const { strategyId: id } = await this.uow.run(async (tx) => this.repository.runtime.mutate(tx, userId, "create", req, req.idempotencyKey, async () => {
      adoption.length = 0;
      const policy = await this.policies.current(tx);
      const limits = policy.limits;
      const controls = await this.repository.readControls(userId, "share", tx);
      if (controls.platform?.pauseNewRisk || controls.platform?.reduceOnly || controls.user?.pauseNewRisk || controls.user?.reduceOnly || policy.invalid) {
        throw conflict("copy_paused", "New copies are paused");
      }
      if (req.allocationUsd < limits.minAllocationUsd) throw conflict("below_min_allocation", `Minimum allocation is $${limits.minAllocationUsd}`, { min: limits.minAllocationUsd });
      if (req.allocationUsd > limits.maxAllocationUsd) throw conflict("above_max_allocation", `Maximum allocation is $${limits.maxAllocationUsd}`, { max: limits.maxAllocationUsd });
      await this.repository.lockLeader(tx, req.leader);
      const account = await this.repository.lockPaperAccount(tx, userId, dec(limits.paperStartingBalanceUsd));
      if (await this.repository.findLive(tx, userId, req.leader)) throw conflict("already_copying", "You are already copying this trader");
      if ((await this.repository.countLive(tx, userId)) >= limits.maxStrategiesPerUser) throw conflict("strategy_limit", `At most ${limits.maxStrategiesPerUser} copies`, { limit: limits.maxStrategiesPerUser });
      // Exact: a request for the whole balance, to the last decimal, is accepted.
      if (Dec.from(account.balance).lt(req.allocationUsd)) throw conflict("insufficient_balance", "Not enough paper balance", { balance: wire(account.balance) });

      const activatedAt = snapshot ? new Date(snapshot.time) : new Date();
      const amount = dec(req.allocationUsd, 6);
      const strategy = await this.repository.insertStrategy(tx, { userId, leaderAddress: req.leader, allocated: amount, cash: amount, activatedAt });
      await this.repository.insertVersion(tx, strategy.id, 1, settings, userId);
      await this.repository.adjustPaperBalance(tx, userId, `-${amount}`);
      await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId, kind: "allocate", amount }]);
      // Watched so its fills arrive (the watcher picks it up on its next refresh).
      // …within the site-wide cap on watched addresses (review finding 34):
      // at the cap, a leader nobody watches yet can't be copied, and the
      // whole start is rolled back.
      try {
        await this.repository.watchLeader(tx, req.leader, (await this.site.get("general")).maxWatchedAddresses);
      } catch (error) {
        if (error instanceof WatchCapacityError) throw conflict("watch_capacity", "The site can't watch more traders right now", { limit: error.limit });
        throw error;
      }
      await this.repository.catchUp(tx, req.leader, activatedAt);

      if (snapshot) {
        for (const ap of held) {
          const szi = Dec.from(ap.position.szi);
          const coin = ap.position.coin;
          const leaderPx = leaderPositionPx(ap.position);
          const leaderSign: 1 | -1 = szi.isPositive ? 1 : -1;
          const sign = settings.direction === "same" ? leaderSign : (-leaderSign as 1 | -1);
          const notional = openNotional({ mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional: szi.abs().mul(leaderPx), strategyEquity: Dec.from(req.allocationUsd), leaderEquity });
          const order = await this.planner.place(tx, {
            strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids, assets,
            coin, leg: "adopt", side: sign > 0 ? "B" : "A", notional: notional ?? Dec.ZERO,
            signalPx: leaderPx, signalTime: activatedAt, signalTids: [],
            dedupeKey: `${strategy.id}:adopt:${coin}:v1`,
            rejectReason: notional !== null ? undefined : settings.sizingMode === "ratio" ? "leader_equity_unknown" : "no_per_trade_amount",
          });
          const adopted = order?.status === "risk_approved";
          adoption.push({ coin, adopted, reason: order?.reason ?? null, size: adopted ? wire(order.size) : 0 });
        }
      }
      await this.repository.runtime.snapshot(tx, { strategyId: strategy.id, time: strategy.createdAt, equity: amount, totalPnl: "0", netDeposits: amount, exposureUsd: "0" });
      await this.repository.runtime.appendEvent(tx, userId, strategy.id, "strategy_created", { mode: "paper", leader: req.leader });
      return { strategyId: strategy.id };
    }));
    const created = await this.one(userId, id);
    return snapshot ? { ...created, adoption } : created;
  }

  /** PATCH /me/copy/strategies/:id — CopyDog's 跟單交易設定: a new version. */
  async patch(userId: number, strategyId: number, input: unknown): Promise<CopyStrategy> {
    const req = parseOr400(patchCopyStrategyRequestSchema, input);
    await this.uow.run(async (tx) => {
      await this.repository.lockCopyUser(tx, userId);
      const strategy = await this.owned(tx, userId, strategyId);
      if (strategy.status === "stopped" || strategy.status === "stopping") throw conflict("strategy_stopped", "This copy has stopped");
      const current = (await this.repository.settingsOf(tx, strategy.id, strategy.version)) as CopyStrategySettings;
      const next: CopyStrategySettings = { ...current, ...req };
      if (next.sizingMode === "fixed" && next.perTradeUsd === null) throw new BadRequestException({ statusCode: 400, code: "per_trade_required", message: "Fixed sizing needs an amount per trade" });
      const version = strategy.version + 1;
      await this.repository.insertVersion(tx, strategy.id, version, next, userId);
      await this.repository.updateStrategy(tx, strategy.id, { version });
    });
    return this.one(userId, strategyId);
  }

  /** POST /me/copy/strategies/:id/funds — CopyDog's 加碼, from the paper balance. */
  async addFunds(userId: number, strategyId: number, input: unknown): Promise<CopyStrategy> {
    const req = parseOr400(addCopyFundsRequestSchema, input);
    const policy = await this.policies.current();
    await this.uow.run(async (tx) => this.repository.runtime.mutate(tx, userId, "topup", { strategyId, ...req }, req.idempotencyKey, async () => {
      await this.repository.lockCopyUser(tx, userId);
      // Lock order: strategy, then paper account (as settlement does).
      const strategy = await this.owned(tx, userId, strategyId);
      if (strategy.status === "stopped" || strategy.status === "stopping") throw conflict("strategy_stopped", "This copy has stopped");
      const account = await this.repository.lockPaperAccount(tx, userId, dec(policy.limits.paperStartingBalanceUsd));
      if (Dec.from(account.balance).lt(req.amountUsd)) throw conflict("insufficient_balance", "Not enough paper balance", { balance: wire(account.balance) });
      if (Dec.from(strategy.allocated).add(req.amountUsd).gt(policy.limits.maxAllocationUsd)) throw conflict("above_max_allocation", `Maximum allocation is $${policy.limits.maxAllocationUsd}`);
      const amount = dec(req.amountUsd, 6);
      await this.repository.adjustPaperBalance(tx, userId, `-${amount}`);
      await this.repository.addToStrategy(tx, strategy.id, { cash: amount, allocated: amount });
      await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId, kind: "allocate", amount }]);
      return { strategyId };
    }));
    return this.one(userId, strategyId);
  }

  /** Return only idle paper collateral, preserving position/reservation margin. */
  async withdrawFunds(userId: number, strategyId: number, input: unknown): Promise<CopyStrategy> {
    this.requireEnabled();
    const req = parseOr400(withdrawCopyFundsRequestSchema, input);
    const row = await this.repository.strategyWithSettings(strategyId);
    if (!row || row.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const coins = await this.repository.positionCoins([strategyId]);
    const [mids, assets] = await Promise.all([this.market.midPrices(coins), this.market.assetInfo(coins)]);
    await this.uow.run((tx) => this.repository.runtime.mutate(tx, userId, "withdraw", { strategyId, ...req }, req.idempotencyKey, async () => {
      await this.repository.lockPoliciesForExecution(tx);
      await this.repository.readControls(userId, "share", tx);
      const strategy = await this.owned(tx, userId, strategyId);
      if (strategy.status === "stopped" || strategy.status === "stopping") throw conflict("strategy_stopped", "This copy has stopped");
      const policy = await this.policies.current(tx);
      if (policy.invalid) throw conflict("risk_policy_invalid", "The current risk policy is unavailable");
      const positions = await this.repository.positionsOf([strategyId], tx);
      const reservations = await this.repository.heldReservations([strategyId], tx);
      const settings = await this.repository.settingsOf(tx, strategyId, strategy.version) as CopyStrategySettings;
      const available = freeCopyCollateral(strategy, settings, positions, reservations, policy.limits, mids, assets);
      if (available === null) throw conflict("collateral_unavailable", "Current collateral cannot be valued");
      if (available.lt(req.amountUsd)) throw conflict("no_free_collateral", "Not enough idle collateral", { available: wire(available) });
      await this.repository.lockPaperAccount(tx, userId, dec(policy.limits.paperStartingBalanceUsd));
      const amount = dec(req.amountUsd, 6);
      await this.repository.addToStrategy(tx, strategyId, { cash: `-${amount}`, withdrawn: amount });
      await this.repository.adjustPaperBalance(tx, userId, amount);
      await this.repository.insertLedger(tx, [{ strategyId, userId, kind: "withdraw", amount: `-${amount}` }]);
      return { strategyId };
    }));
    return this.one(userId, strategyId);
  }

  /** POST /me/copy/strategies/:id/commands — only this strategy, only its owner. */
  async command(userId: number, strategyId: number, command: CopyStrategyCommand, idempotencyKey?: string): Promise<CopyStrategy> {
    const req = parseOr400(copyStrategyCommandRequestSchema, { command, idempotencyKey });
    const own = await this.repository.strategyWithSettings(strategyId);
    if (!own || own.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const mids = command === "close_positions" || command === "stop" ? await this.market.midPrices(await this.repository.positionCoins([strategyId])) : null;
    await this.uow.run((tx) => this.repository.runtime.mutate(tx, userId, "command", { strategyId, ...req }, req.idempotencyKey, async () => {
      await this.controls.strategyCommand(userId, strategyId, command, tx, mids);
      await this.repository.runtime.appendEvent(tx, userId, strategyId, "strategy_command", { mode: "paper", command });
      return { strategyId };
    }));
    return this.one(userId, strategyId);
  }

  /** GET /me/copy/strategies/:id/orders — newest first. */
  async orders(userId: number, strategyId: number, query: unknown = {}): Promise<CopyOrdersResponse> {
    const { before, limit } = parseOr400(copyOrdersQuerySchema, query);
    const row = await this.repository.strategyWithSettings(strategyId);
    if (!row || row.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const rows = await this.repository.ordersOfStrategy(strategyId, limit + 1, before ? BigInt(before) : undefined);
    const items = rows.slice(0, limit).map(toCopyOrder);
    return { items, previousCursor: items.at(-1)?.id ?? null, hasMore: rows.length > limit };
  }

  async ledger(userId: number, strategyId: number, query: unknown = {}): Promise<CopyLedgerResponse> {
    const { before, limit } = parseOr400(copyOrdersQuerySchema, query);
    const owned = await this.repository.strategyWithSettings(strategyId);
    if (!owned || owned.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const rows = await this.repository.ledgerOf(strategyId, limit + 1, before ? BigInt(before) : undefined);
    const items = rows.slice(0, limit).map((row) => ({ id: String(row.id), kind: row.kind, amount: row.amount,
      coin: row.coin, orderId: row.orderId === null ? null : String(row.orderId), createdAt: row.createdAt }));
    return { mode: "paper", items, previousCursor: items.at(-1)?.id ?? null, hasMore: rows.length > limit };
  }

  async fills(userId: number, strategyId: number, query: unknown = {}): Promise<CopyFillsResponse> {
    const { before, limit } = parseOr400(copyOrdersQuerySchema, query);
    const owned = await this.repository.strategyWithSettings(strategyId);
    if (!owned || owned.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const rows = await this.repository.fillsOf(strategyId, limit + 1, before ? BigInt(before) : undefined);
    const items = rows.slice(0, limit).map((row) => ({ id: String(row.id), orderId: String(row.orderId), coin: row.coin, side: row.side,
      size: row.size, px: row.px, fee: row.fee, builderFee: row.builderFee, realizedPnl: row.realizedPnl, ts: row.ts }));
    return { mode: "paper", items, previousCursor: items.at(-1)?.id ?? null, hasMore: rows.length > limit };
  }

  private async owned(tx: Parameters<Parameters<UnitOfWork["run"]>[0]>[0], userId: number, strategyId: number) {
    const strategy = await this.repository.lockStrategy(tx, strategyId);
    if (!strategy || strategy.userId !== userId) throw new NotFoundException("Copy not found");
    return strategy;
  }

  private async one(userId: number, strategyId: number): Promise<CopyStrategy> {
    const row = await this.repository.strategyWithSettings(strategyId);
    if (!row || row.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    const positions = await this.repository.positionsOf([strategyId]);
    const mids = positions.length ? await this.market.midPrices(positions.map((p) => p.coin)) : null;
    const counts = await this.repository.orderCounts([strategyId]);
    const settings = row.settings as CopyStrategySettings;
    const assets = positions.length ? await this.market.assetInfo(positions.map((p) => p.coin)) : null;
    const reserved = await this.repository.heldReservations([strategyId]);
    const policy = await this.policies.current();
    const available = row.strategy.status === "stopped" || row.strategy.status === "stopping" || policy.invalid ? null
      : freeCopyCollateral(row.strategy, settings, positions, reserved, policy.limits, mids, assets);
    return { ...toCopyStrategy(row.strategy, settings, positions, mids, counts.get(strategyId)), freeCollateralUsd: available === null ? null : wire(available) };
  }
}
