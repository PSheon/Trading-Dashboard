import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { and, desc, eq } from "drizzle-orm";
import {
  actions,
  fills,
  leaders,
  CHAIN_DEFAULT,
} from "@trading-dashboard/shared";

import { env } from "../config/env.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import type {
  HlClearinghouseStateResponse,
  HlUserFill,
} from "../hyperliquid/types.js";
import {
  classifyFillsIntoActions,
  isOutOfScopeSpotFill,
  type PositionStateLookup,
} from "./action-classifier.js";
import { ACTION_CREATED_EVENT } from "./action-created.event.js";
import { toFillRow } from "./fill-row.js";

interface PositionState {
  szi: number;
  entryPx: number | null;
  leverageValue: number | null;
  marginMode: string | null;
}

export interface CachedClearinghouseState {
  response: HlClearinghouseStateResponse;
  fetchedAt: Date;
}

function toPositionMap(response: HlClearinghouseStateResponse): Map<string, PositionState> {
  const map = new Map<string, PositionState>();
  for (const ap of response.assetPositions) {
    const p = ap.position;
    const szi = Number(p.szi);
    if (szi === 0) continue; // Hyperliquid can list a flat position; treat as absent.
    map.set(p.coin, {
      szi,
      entryPx: p.entryPx !== undefined ? Number(p.entryPx) : null,
      leverageValue: p.leverage?.value ?? null,
      marginMode: p.leverage?.type ?? null,
    });
  }
  return map;
}

function positionChanged(before: PositionState | undefined, after: PositionState | undefined): boolean {
  if (!before && !after) return false;
  if (!before || !after) return true;
  return (
    before.szi !== after.szi ||
    before.entryPx !== after.entryPx ||
    before.leverageValue !== after.leverageValue ||
    before.marginMode !== after.marginMode
  );
}

/**
 * Polling-only replacement for the PRD's original WS-based W1–W4 (§4.2).
 * Locked architecture change (approved 2026-09-29): Hyperliquid's real WS
 * limit is 10 unique users per IP across user-specific subscriptions — not
 * enough for 100 addresses — so this v1 uses REST polling exclusively for
 * everything: fill discovery, action aggregation, and snapshots. The WS
 * client in `hyperliquid-ws.client.ts` is intentionally left unused.
 *
 * Every poll cycle (§ math in `request-budgeter.service.ts` /
 * `env.ts`):
 *   1. Re-reads `leaders` fresh (active + chain='hyperliquid') — this is
 *      what gives A2/A3 their "within one interval" guarantee for free, no
 *      separate signaling needed.
 *   2. For each address (isolated try/catch — one address's failure never
 *      stops the other 99): fetch clearinghouseState, diff against the
 *      in-memory last-known position map.
 *   3. On any per-coin delta, fetch userFillsByTime for the window since
 *      this address's last successful poll (or since its last known fill,
 *      on the very first poll of a process — see `getWindowStart`), insert
 *      perps fills (deduped on tid), and classify them into `actions` rows.
 *   4. Cache the raw clearinghouseState response so the 5-minute snapshot
 *      job (`scheduler.service.ts`) can write position/equity snapshots
 *      without a second round of API calls (W4 adapted, §11 "儲存維持 5
 *      分鐘一筆").
 */
@Injectable()
export class WatcherService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WatcherService.name);

  private readonly lastKnownPositions = new Map<string, Map<string, PositionState>>();
  private readonly lastPollAt = new Map<string, Date>();
  private readonly cachedState = new Map<string, CachedClearinghouseState>();

  private lastFillAt: Date | null = null;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastCycleStartedAt: Date | null = null;
  private lastCycleCompletedAt: Date | null = null;
  private cyclesCompleted = 0;

  constructor(
    private readonly info: HyperliquidInfoClient,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    // Optional: existing tests construct this service with just
    // (info, db) — event emission is a no-op without it rather than a
    // required 3rd constructor arg everywhere.
    @Optional() private readonly eventEmitter?: EventEmitter2,
  ) {}

  /** Auto-starts on real app boot (§8 可用性: "訂閱清單來自 DB，啟動即重建；不
   * 依賴進程內狀態" — the polling equivalent is "just start polling, the
   * leader list is re-read every cycle anyway"). Skipped under `test` so
   * Nest TestingModule-based tests don't accidentally start live polling —
   * tests that want to exercise the loop call `runPollCycle()`/`start()`
   * directly with a controlled service instance instead. */
  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    this.start();
  }

  onModuleDestroy(): void {
    this.stop();
  }

  /** Starts the recursive poll loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.logger.log(
      `Watcher starting — poll interval ${env.watcherPollIntervalSeconds()}s, weight budget ${env.hyperliquidWeightBudgetPerMin()}/min`,
    );
    this.scheduleNext(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleNext(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.runPollCycle().finally(() => {
        if (this.running) this.scheduleNext(env.watcherPollIntervalSeconds() * 1000);
      });
    }, delayMs);
  }

  /** One full cycle over every active leader. Public so tests (and the A2
   * "pick up a new address within one interval" acceptance criterion) can
   * drive it directly without waiting on the timer. */
  async runPollCycle(): Promise<void> {
    this.lastCycleStartedAt = new Date();
    const activeLeaders = await this.db
      .select({ address: leaders.address })
      .from(leaders)
      .where(and(eq(leaders.chain, CHAIN_DEFAULT), eq(leaders.active, true)));

    await Promise.allSettled(
      activeLeaders.map((l) => this.pollAddress(l.address)),
    );

    // An address that dropped out of the active set (A3 deactivation, or
    // simply removed) should stop being diffed against — otherwise its
    // stale in-memory state lingers forever and a later reactivation would
    // see a bogus "no change" on the first poll back.
    const activeSet = new Set(activeLeaders.map((l) => l.address));
    const staleAddresses = Array.from(this.lastKnownPositions.keys()).filter(
      (addr) => !activeSet.has(addr),
    );
    for (const addr of staleAddresses) {
      this.lastKnownPositions.delete(addr);
      this.lastPollAt.delete(addr);
      this.cachedState.delete(addr);
    }

    this.lastCycleCompletedAt = new Date();
    this.cyclesCompleted += 1;
  }

  private async pollAddress(address: string): Promise<void> {
    try {
      const pollTime = new Date();
      const response = await this.info.clearinghouseState(address);
      const newPositions = toPositionMap(response);
      const previousPositions = this.lastKnownPositions.get(address);

      const changedCoins = new Set<string>();
      const coinsToCheck = new Set([
        ...(previousPositions?.keys() ?? []),
        ...newPositions.keys(),
      ]);
      for (const coin of coinsToCheck) {
        if (positionChanged(previousPositions?.get(coin), newPositions.get(coin))) {
          changedCoins.add(coin);
        }
      }

      if (changedCoins.size > 0) {
        await this.handleDelta(address, previousPositions, newPositions, pollTime);
      }

      this.lastKnownPositions.set(address, newPositions);
      this.lastPollAt.set(address, pollTime);
      this.cachedState.set(address, { response, fetchedAt: pollTime });
    } catch (error) {
      this.logger.error(
        `Poll failed for ${address}: ${(error as Error).message}`,
        (error as Error).stack,
      );
    }
  }

  private async handleDelta(
    address: string,
    previousPositions: Map<string, PositionState> | undefined,
    newPositions: Map<string, PositionState>,
    pollTime: Date,
  ): Promise<void> {
    const windowStart = await this.getWindowStart(address);
    if (!windowStart) {
      // Brand new address, no backfill history yet either — nothing to
      // diff a fill window against on this very first sighting.
      return;
    }

    const startTime = windowStart.getTime() + 1;
    const endTime = pollTime.getTime();
    if (startTime >= endTime) return;

    const rawFills = await this.info.userFillsByTime(address, startTime, endTime);
    const perpsFills = rawFills.filter((f) => !isOutOfScopeSpotFill(f));
    if (perpsFills.length === 0) return;

    const inserted = await this.insertFills(address, perpsFills);
    if (inserted.length === 0) return;

    const stateLookup: PositionStateLookup = {
      hadPositionBefore: (coin) => (previousPositions?.has(coin) ?? false),
      leverageBefore: (coin) => previousPositions?.get(coin)?.leverageValue ?? null,
      hasPositionAfter: (coin) => newPositions.has(coin),
      leverageAfter: (coin) => newPositions.get(coin)?.leverageValue ?? null,
    };

    const drafts = classifyFillsIntoActions(inserted, stateLookup);
    if (drafts.length === 0) return;

    const insertedActions = await this.db
      .insert(actions)
      .values(
        drafts.map((d) => ({
          chain: CHAIN_DEFAULT,
          address,
          coin: d.coin,
          kind: d.kind,
          side: d.side,
          notionalUsd: d.notionalUsd,
          avgPx: d.avgPx,
          leverage: d.leverage,
          fillIds: d.fillIds,
          ts: d.ts,
        })),
      )
      .returning();

    // Rules trigger mechanism (§1 of the M2 task): emit synchronously,
    // in-process, right after the row is persisted — RulesModule listens
    // via @OnEvent rather than polling `actions`. One event per action row
    // (a single delta can classify into several actions, e.g. a close then
    // a fresh open on the same coin in one poll window).
    for (const row of insertedActions) {
      this.eventEmitter?.emit(ACTION_CREATED_EVENT, row);
    }
  }

  /** First-ever poll of an address in this process has no in-memory prior
   * poll time (a fresh deploy, or an address that just came off A2 import).
   * Fall back to the latest fill already on file for it — either from A5
   * backfill or earlier activity — rather than fetching an unbounded
   * window. If there is truly no fill history yet (backfill still running,
   * or a genuinely fill-less address), there is nothing meaningful to diff
   * a window against on this cycle: return null and let the caller skip
   * the fetch, just seeding state so the *next* cycle has a real start. */
  private async getWindowStart(address: string): Promise<Date | null> {
    const inMemory = this.lastPollAt.get(address);
    if (inMemory) return inMemory;
    return this.latestFillTimestamp(address);
  }

  private async latestFillTimestamp(address: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ ts: fills.ts })
      .from(fills)
      .where(and(eq(fills.chain, CHAIN_DEFAULT), eq(fills.address, address)))
      .orderBy(desc(fills.ts))
      .limit(1);
    return row?.ts ?? null;
  }

  /** Inserts fills deduped on (chain, tid) (W2), in ascending time order,
   * and returns the same list for the caller to feed into action
   * aggregation. Windows don't overlap cycle-to-cycle by construction
   * (each starts at the previous cycle's end + 1ms) — EXCEPT if a cycle
   * throws after this fetch but before `pollAddress` updates
   * `lastPollAt`/`lastKnownPositions`: the next cycle then re-fetches the
   * same window and re-derives the same `actions` rows. Accepted trade-off
   * ("never miss a fill" over "never double-count an action" on a rare
   * mid-cycle crash) rather than adding tid-level action dedupe for a
   * failure mode that's already logged and isolated per-address. */
  private async insertFills(address: string, rawFills: HlUserFill[]): Promise<HlUserFill[]> {
    const sorted = [...rawFills].sort((a, b) => a.time - b.time);
    const rows = sorted.map((f) => toFillRow(address, f));

    if (rows.length === 0) return [];

    await this.db.insert(fills).values(rows).onConflictDoNothing();

    const latest = sorted[sorted.length - 1];
    const latestTs = new Date(latest.time);
    if (!this.lastFillAt || latestTs > this.lastFillAt) {
      this.lastFillAt = latestTs;
    }

    return sorted;
  }

  // ---------------------------------------------------------------------
  // Introspection for /health and the 5-minute snapshot job.
  // ---------------------------------------------------------------------

  getCachedStates(): ReadonlyMap<string, CachedClearinghouseState> {
    return this.cachedState;
  }

  /** Synchronous in-process accessor for R1/R3's `equityUsd` (§1 of the M2
   * task): the Rules path needs fresher-than-`equity_snapshots` data, and
   * this cache is already refreshed every poll cycle for free — no extra
   * Hyperliquid call, no DB read. Returns `null` if this address hasn't
   * completed a poll cycle yet (brand new leader, or process just started).
   */
  getEquityUsd(address: string): number | null {
    const entry = this.cachedState.get(address);
    if (!entry) return null;
    return Number(entry.response.marginSummary.accountValue);
  }

  getHeartbeat(): {
    pollerAlive: boolean;
    lastFillAt: Date | null;
    cyclesCompleted: number;
    lastCycleCompletedAt: Date | null;
  } {
    const intervalMs = env.watcherPollIntervalSeconds() * 1000;
    const alive =
      this.running &&
      this.lastCycleCompletedAt !== null &&
      Date.now() - this.lastCycleCompletedAt.getTime() < intervalMs * 3;
    return {
      pollerAlive: alive,
      lastFillAt: this.lastFillAt,
      cyclesCompleted: this.cyclesCompleted,
      lastCycleCompletedAt: this.lastCycleCompletedAt,
    };
  }
}
