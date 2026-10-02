import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { adminCopyControlRequestSchema, type AdminCopyControlRequest, type AdminCopyControlResponse, type CopyControlCommand, type CopyStrategyCommand, type CopyStrategySettings } from "@trading-dashboard/shared/contracts";

import { recordAdminAudit } from "../common/audit/admin-audit.js";
import type { RequestUser } from "../common/auth/current-user.js";
import { hasPermission } from "../common/auth/permissions.js";
import { parseOr400 } from "../common/http/validation.js";
import { UnitOfWork, type DbTransaction } from "../db/unit-of-work.js";
import { CopyMarketService, type Mids } from "./copy-market.service.js";
import { CopyOrderPlanner, type Controls } from "./copy-planner.service.js";
import { CopyRiskPolicyService, type PolicyRead } from "./copy-risk-policy.service.js";
import { CopyRepository, type StrategyRow } from "./copy.repository.js";

type Target = { scope: "platform"; scopeId: 0 } | { scope: "user"; scopeId: number };

const STRATEGY_COMMAND: Record<CopyStrategyCommand, CopyControlCommand> = {
  pause: "pause_new_risk",
  resume: "resume",
  reduce_only: "reduce_only",
  cancel_pending: "cancel_pending",
  close_positions: "close_positions",
  stop: "close_positions",
};

/**
 * The four stop commands (pause_new_risk, cancel_pending, reduce_only,
 * close_positions) and resume, at three levels: one strategy (its owner),
 * one user and the whole platform (admins). Each command bumps the scope's
 * revision in the same transaction as its effects:
 * - pause_new_risk / reduce_only: new risk-increasing orders are refused at
 *   approval (CopyOrderPlanner) and, for any not yet submitted, cancelled
 *   at the execution boundary (CopyExecutionService.submit). Leader
 *   reductions keep being copied. In paper both behave the same; in live
 *   reduce_only will also cancel resting risk-increasing orders.
 * - cancel_pending: cancels every order not yet submitted.
 * - close_positions: pause_new_risk + cancel pending + a reduce-only close
 *   of every open position in scope.
 * - resume: clears pause and reduce-only at this level only (a strategy
 *   resume never lifts a user or platform stop).
 *
 * Lock order, shared with the consumer and executor: control rows, then
 * strategies (ascending id), then orders.
 */
@Injectable()
export class CopyControlService {
  constructor(
    private readonly repository: CopyRepository,
    private readonly uow: UnitOfWork,
    private readonly market: CopyMarketService,
    private readonly planner: CopyOrderPlanner,
    private readonly policies: CopyRiskPolicyService,
  ) {}

  /**
   * A platform- or user-level command (the admin API: AdminCopyController).
   * `input` is parsed here with adminCopyControlRequestSchema (a
   * discriminated union: platform has no userId, user requires one); the
   * parsed target is the only one authorized and acted on. Needs
   * execution.pause, or execution.resume for `resume`. 409 stale_revision
   * when `expectedRevision` isn't the scope's current revision. Audited in
   * admin_audit_logs (event copy.control) in the same transaction.
   * @throws ForbiddenException, NotFoundException (unknown user), ConflictException
   */
  async apply(input: unknown, actor: RequestUser): Promise<AdminCopyControlResponse> {
    const req: AdminCopyControlRequest = parseOr400(adminCopyControlRequestSchema, input);
    const needed = req.command === "resume" ? "execution.resume" : "execution.pause";
    if (!hasPermission(actor, needed)) throw new ForbiddenException(`Requires ${needed}`);
    const target: Target = req.scope === "platform" ? { scope: "platform", scopeId: 0 } : { scope: "user", scopeId: req.userId };
    const mids = req.command === "close_positions" ? await this.market.midPrices() : null;
    const actorUserId = actor.kind === "user" ? actor.id : null;

    return this.uow.run(async (tx) => {
      if (target.scope === "user" && !(await this.repository.userExists(tx, target.scopeId))) throw new NotFoundException("User not found");
      const before = await this.repository.lockControl(tx, target.scope, target.scopeId);
      if (before.revision !== req.expectedRevision) {
        throw new ConflictException({ statusCode: 409, code: "stale_revision", revision: before.revision, message: "Controls changed since this page loaded" });
      }
      const strategies = await this.repository.liveStrategyIdsOfUser(tx, target.scope === "user" ? target.scopeId : null);
      const locked: StrategyRow[] = [];
      for (const { id } of strategies) {
        const s = await this.repository.lockStrategy(tx, id);
        if (s) locked.push(s);
      }
      const flags =
        req.command === "pause_new_risk" || req.command === "close_positions" ? { pauseNewRisk: true, reduceOnly: before.reduceOnly } :
        req.command === "reduce_only" ? { pauseNewRisk: before.pauseNewRisk, reduceOnly: true } :
        req.command === "resume" ? { pauseNewRisk: false, reduceOnly: false } :
        { pauseNewRisk: before.pauseNewRisk, reduceOnly: before.reduceOnly };
      const after = await this.repository.updateControl(tx, target.scope, target.scopeId, flags, actorUserId);
      const result = await this.applyEffects(tx, req.command, locked, mids, `${target.scope}_${req.command}`);
      const event = await this.repository.insertControlEvent(tx, {
        scope: target.scope, scopeId: target.scopeId, command: req.command, revision: after.revision, actorUserId, reason: req.reason, result,
      });
      await recordAdminAudit(tx, actor, "copy.control", `${target.scope}:${target.scopeId}`,
        { pauseNewRisk: before.pauseNewRisk, reduceOnly: before.reduceOnly, revision: before.revision },
        { command: req.command, reason: req.reason, pauseNewRisk: after.pauseNewRisk, reduceOnly: after.reduceOnly, revision: after.revision, ...result });
      return {
        scope: target.scope,
        scopeId: target.scopeId,
        state: { pauseNewRisk: after.pauseNewRisk, reduceOnly: after.reduceOnly, revision: after.revision },
        event: {
          id: String(event.id), scope: target.scope, scopeId: target.scopeId, command: req.command, revision: after.revision,
          actorUserId, actorEmail: null, reason: req.reason, result, createdAt: event.createdAt,
        },
      };
    });
  }

  /** The owner's command on one of their strategies (404 for anyone else's). */
  async strategyCommand(userId: number, strategyId: number, command: CopyStrategyCommand): Promise<void> {
    const mids = command === "close_positions" || command === "stop" ? await this.market.midPrices() : null;
    await this.uow.run(async (tx) => {
      const strategy = await this.repository.lockStrategy(tx, strategyId);
      if (!strategy || strategy.userId !== userId) throw new NotFoundException("Copy not found");
      if (strategy.status === "stopped") throw new ConflictException({ statusCode: 409, code: "strategy_stopped", message: "This copy has stopped" });
      if (command === "resume" && strategy.status === "stopping") {
        throw new ConflictException({ statusCode: 409, code: "strategy_stopping", message: "A stopping copy can't be resumed" });
      }
      const patch: Partial<StrategyRow> = {};
      if (command === "pause" || command === "close_positions") patch.pauseNewRisk = true;
      if (command === "reduce_only") patch.reduceOnly = true;
      if (command === "resume") Object.assign(patch, { pauseNewRisk: false, reduceOnly: false });
      if (command === "stop") Object.assign(patch, { pauseNewRisk: true, status: "stopping" });
      else if (patch.pauseNewRisk === true && strategy.status === "active") patch.status = "paused";
      else if (command === "resume" && strategy.status === "paused") patch.status = "active";
      const updated = await this.repository.updateStrategy(tx, strategy.id, { ...patch, controlRevision: strategy.controlRevision + 1 });
      const mapped = STRATEGY_COMMAND[command];
      const result = await this.applyEffects(tx, mapped, [updated], mids, `strategy_${command}`);
      await this.repository.insertControlEvent(tx, {
        scope: "strategy", scopeId: strategy.id, command: mapped, revision: updated.controlRevision, actorUserId: userId, reason: command === "stop" ? "stop" : null, result,
      });
    });
  }

  private async applyEffects(tx: DbTransaction, command: CopyControlCommand, strategies: StrategyRow[], mids: Mids | null, reason: string) {
    const ids = strategies.map((s) => s.id);
    let cancelledOrders = 0;
    let closeOrders = 0;
    if (command === "pause_new_risk" || command === "reduce_only") cancelledOrders = await this.repository.cancelPending(tx, ids, reason, true);
    if (command === "cancel_pending") cancelledOrders = await this.repository.cancelPending(tx, ids, reason);
    if (command === "close_positions") {
      cancelledOrders = await this.repository.cancelPending(tx, ids, reason);
      closeOrders = await this.closeAll(tx, strategies, mids);
    }
    return { cancelledOrders, closeOrders };
  }

  /** A reduce-only market close of every open position of `strategies`
   * (skipping coins that already have a pending stop-close). */
  private async closeAll(tx: DbTransaction, strategies: StrategyRow[], mids: Mids | null): Promise<number> {
    if (strategies.length === 0) return 0;
    const positions = await this.repository.positionsOf(strategies.map((s) => s.id), tx);
    if (positions.length === 0) return 0;
    const already = await this.repository.pendingStopCloses(tx, strategies.map((s) => s.id));
    const policy: PolicyRead = await this.policies.current(tx);
    const noControls: Controls = { platform: undefined, user: undefined };
    let n = 0;
    for (const p of positions) {
      if (already.has(`${p.strategyId}:${p.coin}`)) continue;
      const strategy = strategies.find((s) => s.id === p.strategyId)!;
      const size = Number(p.size);
      const settings = (await this.repository.settingsOf(tx, strategy.id, strategy.version)) as CopyStrategySettings;
      const order = await this.planner.place(tx, {
        strategy, settings, policy, controls: noControls, mids, assets: null,
        coin: p.coin, leg: "stop_close", side: size > 0 ? "A" : "B", size: Math.abs(size),
        signalPx: mids?.px.get(p.coin) ?? Number(p.entryPx), signalTime: new Date(), signalTids: [],
        dedupeKey: `stop:${strategy.id}:${p.coin}:r${strategy.controlRevision}:${Date.now()}`,
      });
      if (order) n += 1;
    }
    return n;
  }
}
