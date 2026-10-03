import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from "@nestjs/common";
import { z } from "zod";
import { AppConfig } from "../config/app-config.js";
import { BackgroundJobs } from "../runtime/background-jobs.service.js";
import { CopyFollowerLedger } from "./live/copy-follower-ledger.js";
import { HyperliquidFollowerReceiptReader } from "./live/follower-receipt-reader.js";
import { LiveBoundaryError } from "./live/wallet-authorization.js";

import { CopyFollowerScanRepository, type ScanState } from "./copy-follower-scan.repository.js";

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pendingWindow = z.object({ kind: z.enum(["fills", "funding"]), from: ms, to: ms, depth: z.number().int().min(0).max(53) });
const stateSchema = z.object({ from: ms, to: ms, pending: z.array(pendingWindow).max(4096), historicalCompleteness: z.literal("unproven"), observations: z.array(z.unknown()).max(64) })
  .refine(state => state.from <= state.to && state.pending.every(w => w.from >= state.from && w.to <= state.to && w.from <= w.to));


@Injectable()
export class CopyFollowerReconciler {
  constructor(private readonly repository: CopyFollowerScanRepository, private readonly ledger: CopyFollowerLedger,
    private readonly reader: HyperliquidFollowerReceiptReader) {}
  async runOnce(): Promise<void> {
    const claim = await this.repository.claim(); if (!claim) return;
    try {
      const previous = claim.scanState == null ? null : stateSchema.parse(claim.scanState);
      const outstanding = previous?.pending.length ? previous : null;
      const from = outstanding?.from ?? Math.max(0, (claim.through ?? Number(claim.accountCreatedAt)) - 60_000);
      const to = outstanding?.to ?? Date.now();
      const selected = outstanding?.pending.slice(0, 2);
      const retained = outstanding?.pending.slice(2) ?? [];
      const result = await this.reader.read({ accountAddress: claim.address, from, to, maxRequests: 2, ...(selected ? { resumeWindows: selected } : {}) });
      if (result.network !== "testnet" || result.accountAddress !== claim.address || result.from !== from || result.to !== to)
        throw new LiveBoundaryError("follower_receipt_invalid_evidence");
      // No transaction is held across provider reads. A crash after some
      // bookings simply replays the same immutable identities next time.
      const expectedIdentity = { network: "testnet" as const, accountAddress: claim.address };
      for (const receipt of result.fills) await this.ledger.bookFill(claim.accountId, receipt.raw, expectedIdentity);
      for (const receipt of result.funding) await this.ledger.bookFunding(claim.accountId, receipt.raw, expectedIdentity);
      const pending = [...retained, ...result.unresolvedWindows].map(({ kind, from, to, depth }) => ({ kind, from, to, depth }));
      if (pending.length > 4096) throw new LiveBoundaryError("follower_scan_window_limit");
      const scanState: ScanState = { from, to, pending, historicalCompleteness: "unproven", observations: result.observations.slice(-64) };
      // Advance only the operational fetched horizon, and only after all
      // unresolved windows and all receipt bookings have been persisted.
      await this.repository.save(claim, scanState, pending.length ? claim.through : to);
    } catch (error) {
      const code = error instanceof LiveBoundaryError ? error.code : "follower_scan_unavailable";
      if (code === "follower_receipt_invalid_evidence" || code === "follower_receipt_conflict") {
        try { await this.ledger.recordInvalidEvidence(claim.accountId, code, { network: "testnet", accountAddress: claim.address }); }
        catch (bindingError) {
          if (!(bindingError instanceof LiveBoundaryError) || bindingError.code !== "follower_account_identity_changed") throw bindingError;
        }
      }
      await this.repository.issue(claim, code);
      throw new LiveBoundaryError(code);
    }
  }
}

/** One globally admitted account pass per minute (two worst-case 120-weight
 * reads). Read-only at the provider; no orders, transfers or activation. */
@Injectable()
export class CopyFollowerMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CopyFollowerMonitor.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  constructor(private readonly config: AppConfig, private readonly reconciler: CopyFollowerReconciler, private readonly jobs: BackgroundJobs) {}
  onApplicationBootstrap() {
    if (this.config.value.app.nodeEnv === "test" || this.config.value.app.role === "api" || this.config.value.hyperliquid.wallet.network !== "testnet") return;
    this.timer = setInterval(() => void this.tick(), 60_000); this.timer.unref?.();
  }
  onModuleDestroy() { clearInterval(this.timer); }
  async tick() {
    if (this.running || this.jobs.stopping) return; this.running = true;
    try { await this.jobs.run(() => this.reconciler.runOnce()); }
    catch { this.logger.warn("Follower receipt coverage pending; original window retained"); }
    finally { this.running = false; }
  }
}
