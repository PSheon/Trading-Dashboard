import { Injectable, Logger, Optional } from "@nestjs/common";
import type { HeartbeatResponse } from "@trading-dashboard/shared/contracts";

import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { archiveKeys, backfillFloor, floorHour, HOUR_MS, parseArchiveLine, type ArchiveFill } from "./archive-format.js";
import { ArchiveIngestRepository, type ArchiveState, type IngestDirection } from "./archive-ingest.repository.js";
import { LocalArchiveStore, S3ArchiveStore, type ArchiveObject, type ArchiveStore } from "./archive-store.js";
import { decodeLz4Frames, splitLines } from "./lz4-frame.js";

const GB = 1_000_000_000;
/** A tick stops starting objects after this long (the cron fires each minute). */
const TICK_BUDGET_MS = 45_000;
const INSERT_BATCH = 2_000;
/** An address above this many fills in one hourly object is named in the
 * log (it is kept all the same): the accounts that fill the table. */
export const HEAVY_ADDRESS_HOUR = 20_000;

export type ObjectOutcome = "ingested" | "missing" | "over_budget" | "lost" | "idle";

/** Builds the configured store; `undefined` when the ingest is off. */
export function archiveStoreFrom(config: AppConfig): ArchiveStore | undefined {
  const { enabled, localDir, credentials, bucket, region } = config.value.archive;
  if (!enabled) return undefined;
  if (localDir) return new LocalArchiveStore(localDir);
  return credentials ? new S3ArchiveStore({ bucket, region, credentials }) : undefined;
}

/**
 * Reads Hyperliquid's public node archive (hourly, whole-market fill files)
 * and keeps the fills of the tracked set in `history_fills`.
 *
 * Two cursors over the same hourly keys:
 * - live, forward: the next hour once it has settled; every active address
 *   is filtered for, and its covered span grows to the hour's end;
 * - backfill, backward: from the latest span start down to the window's
 *   floor (`backfillDays` before today, never before the archive's first
 *   day); an address joins the pass at the hour just before its own span,
 *   so spans stay contiguous and the newest history arrives first. A new
 *   pass (addresses that joined since, or a longer window) starts at the
 *   earliest `passIntervalHours` after the previous one began.
 *
 * An object is one unit of work: its fills are inserted (idempotent), then
 * cursor + coverage + transfer accounting commit in one transaction. A
 * restart resumes at the stored cursor and re-reads at most that object.
 * Spend is bounded twice: bytes per tick (`maxBytesPerMinute`) and dollars
 * per UTC day (`maxDailyUsd` at `usdPerGb`); an object that would cross the
 * daily cap is not downloaded. A malformed object stops its cursor
 * (`parse_error`) rather than storing guesses; a missing backfill object
 * leaves its participants' spans where they are, so they stay "partial".
 * No address is dropped for trading a lot unless `maxFillsPerAddressHour`
 * is set; the heaviest are named in the log instead.
 */
@Injectable()
export class ArchiveIngestService {
  private readonly logger = new Logger(ArchiveIngestService.name);
  private running: Promise<void> | undefined;
  private readonly store: ArchiveStore | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: ArchiveIngestRepository,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
    @Optional() store?: ArchiveStore,
  ) {
    this.store = store ?? archiveStoreFrom(config);
  }

  get enabled(): boolean {
    return this.store !== undefined;
  }

  /** Addresses that just entered the tracked set (the next tick's sync
   * would find them too). */
  enqueue(addresses: string[]): Promise<void> {
    return this.repository.enqueue(addresses);
  }

  /** Cron entry point: one run at a time; never throws. */
  onTick(): Promise<void> {
    if (!this.enabled || this.jobs.stopping) return Promise.resolve();
    this.running ??= this.jobs.run(async () => {
      // A run cut short by its time budget goes straight on: an object that
      // takes longer than the budget would otherwise be the only one of its
      // minute, and the rest of that minute idle. A run that stopped for
      // any other reason (byte pace, daily cap, nothing due) waits for the
      // next cron tick.
      for (;;) {
        const started = Date.now();
        const outcomes = await this.tick();
        if (this.jobs.stopping || outcomes.at(-1) !== "ingested" || Date.now() - started < TICK_BUDGET_MS) break;
      }
    })
      .catch(async (error: Error) => {
        // Name only: S3 errors can describe the account and the request.
        this.logger.warn(`Archive ingest failed: ${error.name}`);
        await this.repository.note(errorCode(error)).catch(() => undefined);
      })
      .finally(() => { this.running = undefined; });
    return this.running!;
  }

  /** Admits new tracked addresses, then ingests objects until the byte,
   * dollar or time budget of this run is used. Returns each outcome. */
  async tick(now = Date.now()): Promise<ObjectOutcome[]> {
    if (!this.store) return [];
    const options = this.config.value.archive;
    const started = Date.now();
    const floor = backfillFloor(now, options.start, options.backfillDays);
    await this.repository.syncTrackedSet();
    const outcomes: ObjectOutcome[] = [];
    let bytes = 0;
    let liveDone = false;
    while (!this.jobs.stopping && bytes < options.maxBytesPerMinute && Date.now() - started < TICK_BUDGET_MS) {
      let state = await this.repository.state();
      if (state.liveNextHour === null) {
        // First run: start with the last hour that has ended.
        state = await this.repository.moveCursor(state, { liveNextHour: new Date(floorHour(now) - HOUR_MS) }) ?? state;
        if (state.liveNextHour === null) break;
      }
      const liveHour = state.liveNextHour.getTime();
      const liveDue = !liveDone && liveHour + HOUR_MS + options.settleMinutes * 60_000 <= now;
      let direction: IngestDirection;
      let hour: number;
      if (liveDue) {
        direction = "live";
        hour = liveHour;
      } else {
        if (!options.backfill) break;
        if (state.backfillCursorHour === null) {
          // Every pass downloads the whole window again for whoever joined
          // since the last one, so passes are spaced.
          if (state.backfillPassStartedAt && now - state.backfillPassStartedAt.getTime() < options.passIntervalHours * HOUR_MS) break;
          const start = await this.repository.backfillStart(floor);
          if (start === null || start < floor) break;
          state = await this.repository.moveCursor(state, { backfillCursorHour: new Date(start), backfillPassStartedAt: new Date(now) }) ?? state;
          if (state.backfillCursorHour === null) break;
        }
        direction = "backfill";
        hour = state.backfillCursorHour.getTime();
      }
      const outcome = await this.ingestObject(state, direction, hour, now, floor);
      outcomes.push(outcome.result);
      bytes += outcome.bytes;
      if (outcome.result === "ingested" || outcome.result === "idle") continue;
      if (outcome.result === "missing" && direction === "live") {
        // Not published yet: that is the archive's lag. Backfill may still run.
        liveDone = true;
        continue;
      }
      if (outcome.result === "missing") {
        // A hole below the participants' spans: they stay partial. End the
        // pass; the next one starts from the latest span and retries it
        // (without waiting out the pass interval: nothing was downloaded).
        await this.repository.moveCursor(await this.repository.state(), { backfillCursorHour: null, backfillPassStartedAt: null });
        await this.repository.note("missing_object");
      }
      if (outcome.result === "over_budget") await this.repository.note("daily_budget_reached");
      break;
    }
    return outcomes;
  }

  /** Downloads, filters and commits one hour: one object, or two for the
   * hour in which the archive changed format (see `archiveKeys`). */
  private async ingestObject(state: ArchiveState, direction: IngestDirection, hour: number, now: number, floor: number): Promise<{ result: ObjectOutcome; bytes: number }> {
    const options = this.config.value.archive;
    const keys = archiveKeys(hour);
    const key = keys.join(" + ");
    const day = new Date(now).toISOString().slice(0, 10);
    const { addresses, snapshotAt } = await this.repository.participants(direction, hour);
    const commit = { direction, hour, key, snapshotAt, floor, day, excluded: [] as string[], bytes: 0, fillsSeen: 0, fillsKept: 0 };
    if (addresses.size === 0) {
      // Nothing to filter for: move on without paying for the object.
      return { result: (await this.repository.commitObject(state, commit)) ? "idle" : "lost", bytes: 0 };
    }
    const objects: ArchiveObject[] = [];
    const cancel = () => Promise.all(objects.map((object) => object.cancel()));
    for (const name of keys) {
      const object = await this.store!.open(name, this.jobs.signal);
      if (!object) {
        await cancel();
        return { result: "missing", bytes: 0 };
      }
      objects.push(object);
    }
    const size = objects.reduce((sum, object) => sum + object.size, 0);
    const spentToday = state.spendDay === day ? state.spendDayBytes : 0;
    if (((spentToday + size) / GB) * options.usdPerGb > options.maxDailyUsd) {
      await cancel();
      return { result: "over_budget", bytes: 0 };
    }
    const perAddress = new Map<string, number>();
    const excluded = new Set<string>();
    let pending: ArchiveFill[] = [];
    let seen = 0;
    let kept = 0;
    for (const object of objects) for await (const line of splitLines(decodeLz4Frames(object.body))) {
      if (this.jobs.stopping) {
        await cancel();
        return { result: "lost", bytes: 0 };
      }
      for (const entry of parseArchiveLine(line)) {
        seen += 1;
        if (!addresses.has(entry.address) || excluded.has(entry.address)) continue;
        const count = (perAddress.get(entry.address) ?? 0) + 1;
        perAddress.set(entry.address, count);
        // No cap by default: every fill of every tracked address is kept.
        if (options.maxFillsPerAddressHour > 0 && count > options.maxFillsPerAddressHour) {
          excluded.add(entry.address);
          continue;
        }
        pending.push(entry);
        kept += 1;
      }
      if (pending.length >= INSERT_BATCH) {
        await this.repository.insertFills(pending);
        pending = [];
      }
    }
    await this.repository.insertFills(pending);
    const saved = await this.repository.commitObject(state, { ...commit, excluded: [...excluded], bytes: size, fillsSeen: seen, fillsKept: kept });
    if (!saved) return { result: "lost", bytes: size };
    this.logger.log(`Archive ${direction} ${key}: ${size} bytes, ${seen} fills, ${kept} kept for ${perAddress.size} addresses`);
    const heavy = [...perAddress].filter(([, count]) => count > HEAVY_ADDRESS_HOUR).sort((a, b) => b[1] - a[1]);
    if (heavy.length > 0) this.logger.warn(`Archive ${key}: above ${HEAVY_ADDRESS_HOUR} fills in the hour: ${heavy.map(([address, count]) => `${address} ${count}${excluded.has(address) ? " (excluded)" : ""}`).join(", ")}`);
    return { result: "ingested", bytes: size };
  }

  /** `/health` figures: cursors, lag, volume and today's spend. */
  async status(now = Date.now()): Promise<NonNullable<HeartbeatResponse["archive"]>> {
    const options = this.config.value.archive;
    const floor = backfillFloor(now, options.start, options.backfillDays);
    const [state, addresses] = await Promise.all([this.repository.state(), this.repository.coverageCounts(floor)]);
    const today = new Date(now).toISOString().slice(0, 10);
    const spendDayBytes = state.spendDay === today ? state.spendDayBytes : 0;
    return {
      enabled: this.enabled,
      liveNextHour: state.liveNextHour,
      backfillCursorHour: state.backfillCursorHour,
      backfillFloor: new Date(floor),
      backfillPassStartedAt: state.backfillPassStartedAt,
      backfillNextPassAt: state.backfillPassStartedAt ? new Date(state.backfillPassStartedAt.getTime() + options.passIntervalHours * HOUR_MS) : null,
      lagSeconds: state.liveNextHour ? Math.max(0, Math.round((now - state.liveNextHour.getTime()) / 1000)) : null,
      objects: state.objects,
      bytes: state.bytes,
      fillsSeen: state.fillsSeen,
      fillsKept: state.fillsKept,
      spendDayBytes,
      spendDayUsd: Math.round((spendDayBytes / GB) * options.usdPerGb * 10_000) / 10_000,
      maxDailyUsd: options.maxDailyUsd,
      addresses,
      lastObjectKey: state.lastObjectKey,
      lastRunAt: state.lastRunAt,
      lastError: state.lastError,
    };
  }
}

function errorCode(error: Error): string {
  if (error.name === "ArchiveFormatError") return "parse_error";
  if (error.name === "Lz4FormatError") return "corrupt_object";
  if (error.name === "ArchiveAccessError") return "access_error";
  return "ingest_failed";
}
