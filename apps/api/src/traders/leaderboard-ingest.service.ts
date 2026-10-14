import { Injectable, Logger, Optional } from "@nestjs/common";

import { AppConfig } from "../config/app-config.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { LeaderboardIngestRepository } from "./leaderboard-ingest.repository.js";
import { SettingsService } from "../settings/settings.service.js";
import {
  LEADERBOARD_URL,
  parseLeaderboard,
  parseVaults,
  VAULTS_URL,
  type TraderStatsInsert,
} from "./leaderboard.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { LEADERBOARD_FETCH_TIMEOUT_MS } from '../config/constants/http.js';


interface IngestResult {
  rows: number;
  removed: number;
  /** Rows flagged as vaults; null when the vault list couldn't be fetched
   * and the previous flags were kept. */
  vaults: number | null;
  fetchMs: number;
  writeMs: number;
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(LEADERBOARD_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(LEADERBOARD_FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${url} failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Imports Hyperliquid's leaderboard into `trader_stats` (Stage 2 §4) when
 * older than `DISCOVERY_LEADERBOARD_REFRESH_MINUTES` (checked every minute
 * and at startup). Vaults are flagged from the vault list (§10).
 *
 * Each import replaces the table in one transaction (readers see old or
 * new). A failed vault list keeps the previous `is_vault` flags. The stats
 * host is not the info API: no REST weight.
 */
@Injectable()
export class LeaderboardIngestService {
  private readonly logger = new Logger(LeaderboardIngestService.name);
  private running: Promise<IngestResult> | undefined;
  private vaults: { addresses: Set<string>; fetchedAt: Date } | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: LeaderboardIngestRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly settings: SettingsService,
    @Optional() private readonly jobs: BackgroundJobs = new BackgroundJobs(),
  ) {}

  start(): void {
    if (this.config.value.app.nodeEnv === "test") return;
    this.bootstrap()
      .catch((error: unknown) => this.logger.error(`Startup leaderboard import failed: ${safeErrorText(error)}`));
  }

  private async bootstrap(): Promise<void> {
    // A fresh table skips the import, but profiles still need the vault set.
    if (!(await this.refreshIfStale())) await this.loadVaults();
  }

  async onTick(): Promise<void> {
    try {
      await this.refreshIfStale();
    } catch (error) {
      this.logger.error(`Leaderboard import failed: ${safeErrorText(error)}`);
    }
  }

  /** Whether `address` is in the last vault list fetched (false before any). */
  isVault(address: string): boolean {
    return this.vaults?.addresses.has(address) ?? false;
  }

  /** When the last import landed, or null if the table is empty. */
  async lastImportAt(): Promise<Date | null> {
    return this.repository.lastImportAt();
  }

  async refreshIntervalMs(): Promise<number> {
    const snapshot = await this.settings.getAll();
    this.settings.acknowledgeDiscovery("leaderboard", snapshot);
    return this.config.value.tuning.discovery.leaderboardRefreshMinutes * 60_000;
  }

  /** Imports if the table is empty or older than the configured interval. */
  async refreshIfStale(now = Date.now()): Promise<IngestResult | null> {
    if (this.jobs.stopping) return null;
    const [last, interval] = await Promise.all([this.lastImportAt(), this.refreshIntervalMs()]);
    if (last && now - last.getTime() < interval) return null;
    return this.refresh();
  }

  /** Fetches and imports; concurrent callers share one run. */
  refresh(): Promise<IngestResult> {
    this.running ??= this.jobs.run(() => this.run()).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Fetches the vault list and replaces the in-memory set. */
  async loadVaults(): Promise<Set<string>> {
    const addresses = parseVaults(await fetchJson(VAULTS_URL, this.jobs.signal));
    this.vaults = { addresses, fetchedAt: new Date() };
    return addresses;
  }

  private async run(): Promise<IngestResult> {
    const started = Date.now();
    const [board, vaultList] = await Promise.allSettled([fetchJson(LEADERBOARD_URL, this.jobs.signal), this.loadVaults()]);
    if (board.status === "rejected") throw board.reason;
    const fetchMs = Date.now() - started;
    let vaults: Set<string> | null = null;
    if (vaultList.status === "fulfilled") vaults = vaultList.value;
    else this.logger.warn(`Vault list failed, keeping previous vault flags: ${safeErrorText(vaultList.reason)}`);

    const importedAt = new Date();
    // Without a fresh list, new rows use the last list this process fetched;
    // existing rows keep their flags (updateVaultFlags = false).
    const rows = parseLeaderboard(board.value, importedAt, vaults ?? this.vaults?.addresses);
    const writeStarted = Date.now();
    const removed = await this.replaceAll(rows, importedAt, vaults !== null);
    const result: IngestResult = {
      rows: rows.length,
      removed,
      vaults: vaults ? rows.filter((r) => r.isVault).length : null,
      fetchMs,
      writeMs: Date.now() - writeStarted,
    };
    this.logger.log(
      `Leaderboard imported: ${result.rows} rows, ${result.removed} removed, ${result.vaults ?? "unchanged"} vaults ` +
        `(fetch ${fetchMs} ms, write ${result.writeMs} ms)`,
    );
    return result;
  }

  /**
   * Upserts `rows` and deletes every other row in one transaction; returns
   * rows removed. `updateVaultFlags` false keeps existing `is_vault`.
   * Refuses an empty import rather than wiping the table.
   */
  async replaceAll(rows: TraderStatsInsert[], importedAt: Date, updateVaultFlags = true): Promise<number> {
    if (rows.length === 0) throw new Error("Leaderboard import has no rows; keeping the current table");
    return this.unitOfWork.run(async (tx) => {
      return this.repository.replaceAll(tx, rows, importedAt, updateVaultFlags);
    });
  }
}
