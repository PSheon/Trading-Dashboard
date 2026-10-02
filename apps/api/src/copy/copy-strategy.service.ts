import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  addCopyFundsRequestSchema,
  createCopyStrategyRequestSchema,
  patchCopyStrategyRequestSchema,
  type CopyOrdersResponse,
  type CopyOverviewResponse,
  type CopyStrategy,
  type CopyStrategyCommand,
  type CopyStrategySettings,
} from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import type { HlClearinghouseStateResponse } from "../hyperliquid/types.js";
import { SettingsService } from "../settings/settings.service.js";
import { CopyControlService } from "./copy-control.service.js";
import { CopyMarketService } from "./copy-market.service.js";
import { dec, openNotional } from "./copy-math.js";
import { toCopyOrder, toCopyStrategy } from "./copy.mappers.js";
import { CopyOrderPlanner, marketDataGap } from "./copy-planner.service.js";
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
    const [positions, counts] = await Promise.all([this.repository.positionsOf(ids), this.repository.orderCounts(ids)]);
    const mids = positions.length ? await this.market.midPrices() : null;
    const strategies = rows.map((r) => toCopyStrategy(r.strategy, r.settings as CopyStrategySettings, positions, mids, counts.get(r.strategy.id)));
    const live = strategies.filter((s) => s.status !== "stopped");
    const liveEquity = live.reduce<number | null>((a, s) => (a === null || s.equity === null ? null : a + s.equity), 0);
    const balance = Number(account.balance);
    const totalValue = liveEquity === null ? null : balance + liveEquity;
    const startingBalance = Number(account.startingBalance);
    return {
      mode: this.config.value.copy.mode,
      paper: {
        balance,
        startingBalance,
        allocated: live.reduce((a, s) => a + s.allocated, 0),
        totalValue,
        totalPnl: totalValue === null ? null : totalValue - startingBalance,
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
    let snapshot: HlClearinghouseStateResponse | null = null;
    if (req.copyStartMode === "adopt") {
      try {
        snapshot = await this.market.leaderSnapshot(req.leader);
      } catch (error) {
        this.logger.warn(`Leader snapshot for ${req.leader} failed: ${(error as Error).message}`);
        throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Couldn't read the trader's positions; try again" });
      }
    }
    const held = (snapshot?.assetPositions ?? []).filter((ap) => { const szi = Number(ap.position.szi); return Number.isFinite(szi) && szi !== 0; });
    const mids = held.length ? await this.market.midPrices() : null;
    const assets = held.length ? await this.market.assetInfo() : null;
    // Adoption is all-or-nothing on market data: without mids or the
    // universe no adoption order can be sized, and a copy that started
    // without the leader's positions would stay wrong until the leader
    // trades again. Nothing is created; the person retries (the web shows
    // this code as a toast).
    const gap = held.map((ap) => marketDataGap(mids, assets, ap.position.coin)).find((g) => g !== null);
    if (gap) {
      this.logger.warn(`Copy of ${req.leader} not started: ${gap} unavailable for adoption`);
      throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Market data is unavailable, so the trader's positions can't be copied right now; try again" });
    }

    // Ratio sizing divides by the leader's whole account value. A read of
    // it that failed is the same case as missing market data: start nothing.
    const equity = held.length && settings.sizingMode === "ratio" ? await this.market.leaderEquity(req.leader) : null;
    if (equity?.state === "failed") {
      throw new ServiceUnavailableException({ statusCode: 503, code: "leader_unavailable", message: "Couldn't read the trader's account value; try again" });
    }
    const leaderEquity = equity?.state === "known" ? equity.value : null;

    const { id } = await this.uow.run(async (tx) => {
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
      if (Number(account.balance) + 1e-9 < req.allocationUsd) throw conflict("insufficient_balance", "Not enough paper balance", { balance: Number(account.balance) });

      const activatedAt = snapshot ? new Date(snapshot.time) : new Date();
      const amount = dec(req.allocationUsd, 6);
      const strategy = await this.repository.insertStrategy(tx, { userId, leaderAddress: req.leader, allocated: amount, cash: amount, activatedAt });
      await this.repository.insertVersion(tx, strategy.id, 1, settings, userId);
      await this.repository.adjustPaperBalance(tx, userId, `-${amount}`);
      await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId, kind: "allocate", amount }]);
      // Watched so its fills arrive (the watcher picks it up on its next refresh).
      await this.repository.watchLeader(tx, req.leader);
      await this.repository.catchUp(tx, req.leader, activatedAt);

      if (snapshot) {
        for (const ap of held) {
          const szi = Number(ap.position.szi);
          const coin = ap.position.coin;
          const leaderPx = Number(ap.position.positionValue ?? 0) / Math.abs(szi) || Number(ap.position.entryPx ?? 0);
          const leaderSign: 1 | -1 = szi > 0 ? 1 : -1;
          const sign = settings.direction === "same" ? leaderSign : (-leaderSign as 1 | -1);
          const notional = openNotional({ mode: settings.sizingMode, perTradeUsd: settings.perTradeUsd, leaderNotional: Math.abs(szi) * leaderPx, strategyEquity: req.allocationUsd, leaderEquity });
          await this.planner.place(tx, {
            strategy, settings, policy, controls: { platform: controls.platform, user: controls.user }, mids, assets,
            coin, leg: "adopt", side: sign > 0 ? "B" : "A", notional: notional ?? 0,
            signalPx: leaderPx, signalTime: activatedAt, signalTids: [],
            dedupeKey: `${strategy.id}:adopt:${coin}:v1`,
            rejectReason: notional !== null ? undefined : settings.sizingMode === "ratio" ? "leader_equity_unknown" : "no_per_trade_amount",
          });
        }
      }
      return { id: strategy.id };
    });
    return this.one(userId, id);
  }

  /** PATCH /me/copy/strategies/:id — CopyDog's 跟單交易設定: a new version. */
  async patch(userId: number, strategyId: number, input: unknown): Promise<CopyStrategy> {
    const req = parseOr400(patchCopyStrategyRequestSchema, input);
    await this.uow.run(async (tx) => {
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
    await this.uow.run(async (tx) => {
      // Lock order: strategy, then paper account (as settlement does).
      const strategy = await this.owned(tx, userId, strategyId);
      if (strategy.status === "stopped" || strategy.status === "stopping") throw conflict("strategy_stopped", "This copy has stopped");
      const account = await this.repository.lockPaperAccount(tx, userId, dec(policy.limits.paperStartingBalanceUsd));
      if (Number(account.balance) + 1e-9 < req.amountUsd) throw conflict("insufficient_balance", "Not enough paper balance", { balance: Number(account.balance) });
      if (Number(strategy.allocated) + req.amountUsd > policy.limits.maxAllocationUsd) throw conflict("above_max_allocation", `Maximum allocation is $${policy.limits.maxAllocationUsd}`);
      const amount = dec(req.amountUsd, 6);
      await this.repository.adjustPaperBalance(tx, userId, `-${amount}`);
      await this.repository.addToStrategy(tx, strategy.id, { cash: amount, allocated: amount });
      await this.repository.insertLedger(tx, [{ strategyId: strategy.id, userId, kind: "allocate", amount }]);
    });
    return this.one(userId, strategyId);
  }

  /** POST /me/copy/strategies/:id/commands — only this strategy, only its owner. */
  async command(userId: number, strategyId: number, command: CopyStrategyCommand): Promise<CopyStrategy> {
    await this.controls.strategyCommand(userId, strategyId, command);
    return this.one(userId, strategyId);
  }

  /** GET /me/copy/strategies/:id/orders — newest first. */
  async orders(userId: number, strategyId: number): Promise<CopyOrdersResponse> {
    const row = await this.repository.strategyWithSettings(strategyId);
    if (!row || row.strategy.userId !== userId) throw new NotFoundException("Copy not found");
    return { items: (await this.repository.ordersOfStrategy(strategyId, 100)).map(toCopyOrder) };
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
    const mids = positions.length ? await this.market.midPrices() : null;
    const counts = await this.repository.orderCounts([strategyId]);
    return toCopyStrategy(row.strategy, row.settings as CopyStrategySettings, positions, mids, counts.get(strategyId));
  }
}
