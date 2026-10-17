import { isFundingNotDispatched } from './copy-funding-exchange.client.js';
import { BadGatewayException, BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from "@nestjs/common";
import { Dec } from "../common/decimal/dec.js";
import { safeErrorText } from "../runtime/safe-error-text.js";
import { WALLET_NETWORK_HL, type WalletNetworkHyperliquid } from "../hyperliquid/wallet-network-hyperliquid.js";
import { verifyTypedData } from "viem";
import { adminResolveCopyFundingSchema, copyFundingInputSchema, usdSendTypedData, WALLET_NETWORKS, type AdminResolvedCopyFunding, type CopyFunding } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient, MAX_LIST_ITEMS } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import { BusyException } from "../traders/busy.js";
import { isBusyError } from '../traders/traders.controller.js';
import type { RequestUser } from "../common/auth/current-user.js";
import { parseOr400 } from "../common/http/validation.js";
import type { HlLedgerUpdate } from "../hyperliquid/types.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyFundingRepository, type FundingRow, type FundingSender } from "./copy-funding.repository.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { fundingCreditEvidence, fundingOtherOperation } from "./copy-funding-evidence.js";
import { classify } from "./live/error-class.js";
import { privyIdentityFresh } from "./live/privy-identity-freshness.js";
import { fundingBackoffMs, fundingScanSchema, fundingDetailBatch, type FundingScan } from './copy-funding-scan.js';
import { FUNDING_NONCE_EXPIRY_MS, FUNDING_NONCE_SKEW_MS } from '../config/constants/timings.js';
import { BUSY_RETRY_AFTER_MS } from '../config/constants/http.js';
import { jsonDigest as digest } from "../common/crypto/digest.js";

/** An operator's ledger read: a full page reads on (oldest first), at most
 * this many pages, as the withdrawal resolution. */
const RESOLVE_LEDGER_PAGE = 500, RESOLVE_LEDGER_MAX_PAGES = 20;
/** Explorer reads an operator's "never executed" may pay for. */
const RESOLVE_MAX_CANDIDATES = 20;
const resolveConflict = (code: string, message: string) => new ConflictException({ statusCode: 409, code, message });
export const wire = (row: FundingRow): CopyFunding => ({ id: row.id, accountId: row.accountId, strategyId: row.strategyId,
  network: row.network, address: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce,
  status: row.status, canCancel: ["prepared", "unknown"].includes(row.status) && !row.attemptedAt,
  transactionHash: row.transactionHash, creditedAmount: row.creditedAmount, fee: row.fee, direction: row.direction, stopId: row.stopId,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

/** Strategy funding for live copies (COPY_TRADING_MODE testnet or live); setup
 * funds never become paper collateral. Off while copy trading is disabled. */
@Injectable()
export class CopyFundingService {
  private readonly logger = new Logger(CopyFundingService.name);
  private readonly lookups = new TtlCache<CopyFunding>(15_000);
  constructor(private readonly config: AppConfig, private readonly repository: CopyFundingRepository,
    private readonly wallets: CopyWalletService, private readonly exchange: CopyFundingExchangeClient, private readonly info: HyperliquidInfoClient,
    /** The wallet network's own budget and egress (testnet's), not mainnet's. */
    @Optional() @Inject(WALLET_NETWORK_HL) private readonly walletNetwork: WalletNetworkHyperliquid | null = null) {}
  private get available() { return this.config.value.copy.mode !== "disabled"; }
  private assertAvailable() { if (!this.available) throw new ServiceUnavailableException("Strategy funding is not available right now"); }
  async overview(userId: number) {
    const wallets = await this.wallets.overview(userId); // enabled owner check; no provider mutations
    return { available: this.available && wallets.available, network: this.config.value.hyperliquid.wallet.network, operations: (await this.repository.list(userId)).map(wire) };
  }
  private async verified(userId: number, accountId: string) {
    const overview = await this.wallets.overview(userId);
    const previous = overview.accounts.find((entry) => entry.id === accountId);
    if (!previous) throw new NotFoundException("Execution account not found");
    // Funding cannot implicitly create a wallet. Preparation is a separate,
    // explicit user action; reconcile only already verified identities here.
    if (!overview.available || previous.state !== "ready" || !previous.address) throw new ConflictException("Execution wallet verification is pending");
    const account = await this.wallets.reconcile(userId, accountId);
    if (account.state !== "ready" || !account.address || account.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("Execution wallet verification is pending");
    return account;
  }
  async reserve(userId: number, accountId: string, body: unknown, internal?: { liveSetupId: string }) {
    this.assertAvailable();
    const parsed = copyFundingInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid funding request");
    await this.verified(userId, accountId);
    return wire(await this.repository.reserve(userId, accountId, this.config.value.hyperliquid.wallet.network, parsed.data, this.liveGuard(parsed.data.amount), internal?.liveSetupId));
  }
  /** Live deposits: listed owners only, total within the stricter of COPY_LIVE_MAX_ALLOCATION_USD
   * and the policy (security review). */
  private liveGuard(amount: string) {
    const live = this.config.value.copy.live;
    if (!live) return undefined;
    return ({ privyUserId, depositedUsd, policyMaxAllocationUsd }: { privyUserId: string; depositedUsd: string; policyMaxAllocationUsd: number | null }) => {
      if (live.allowedPrivyUserIds && !live.allowedPrivyUserIds.has(privyUserId))
        throw new ConflictException({ statusCode: 409, code: "live_not_allowed", message: "Real-fund copies are not open to your account yet; paper copies are" });
      const caps = [live.caps.maxAllocationUsd, policyMaxAllocationUsd].filter((v): v is number => typeof v === "number");
      if (caps.length && Dec.from(depositedUsd).add(amount).gt(String(Math.min(...caps))))
        throw new ConflictException({ statusCode: 409, code: "above_max_allocation", message: "This would put more than the maximum allocation in the copy", max: Math.min(...caps) });
    };
  }
  /** `via`: a setup's confirm sends its own deposit (FundingSender); the
   * public routes send only a deposit of no setup. */
  async claim(userId: number, id: string, via: FundingSender = {}) {
    this.assertAvailable();
    const row = await this.repository.find(userId, id);
    if (row.direction !== "to_account") throw new ConflictException("A return is approved through its own consent");
    await this.verified(userId, row.accountId);
    const claimed = await this.repository.claim(userId, id, via);
    return { operation: wire(claimed.row), claimed: claimed.claimed };
  }
  async cancel(userId: number, id: string) { await this.wallets.overview(userId); return wire(await this.repository.cancel(userId, id)); }
  async submit(userId: number, id: string, signature: string, via: FundingSender = {}) {
    this.assertAvailable();
    const row = await this.repository.find(userId, id);
    if (row.direction !== "to_account") throw new ConflictException("A return is approved through its own consent");
    if (row.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("Funding network changed");
    let valid = false;
    try { valid = /^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature) && await verifyTypedData({ ...usdSendTypedData(WALLET_NETWORKS[row.network], row.destination, row.amount, row.nonce), address: row.address as `0x${string}`, signature: signature as `0x${string}` }); } catch { /* Never log signing inputs. */ }
    if (!valid) throw new BadRequestException("Invalid funding signature");
    if (row.status !== "unknown" || !row.claimedAt) return wire(row);
    if (row.attemptedAt) return wire(row);
    try {
      if (!await this.exchange.available(row)) {
        await this.repository.restoreUnsent(userId, id);
        throw new ConflictException({ statusCode: 409, code: "insufficient_main_balance", message: "Insufficient transferable USDC" });
      }
      await this.exchange.acquire();
    } catch (error) {
      await this.repository.restoreUnsent(userId, id);
      if (error instanceof ConflictException) throw error;
      throw new BusyException(BUSY_RETRY_AFTER_MS);
    }
    // Reverify identity after balance/budget reads, before durable attempt.
    const identityCheckedAt = Date.now();
    const account = await this.verified(userId, row.accountId);
    const attempt = await this.repository.beginSubmit(userId, id, via);
    if (!attempt) return wire(await this.repository.find(userId, id));
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, () => {
      const now = Date.now();
      this.assertAvailable();
      // The account's Privy identity (three Privy calls): its own bound, not
      // the exchange's 5 s (PRIVY_IDENTITY_MAX_AGE_MS).
      if (!privyIdentityFresh(identityCheckedAt, now) ||
        account.id !== attempt.accountId || account.address !== attempt.destination || account.network !== attempt.network ||
        attempt.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("funding_identity_evidence_expired");
    }); } catch (error) {
      if (isFundingNotDispatched(error, attempt)) {
        const restored = await this.repository.restoreNotDispatched(userId, attempt, error);
        return wire(restored ?? await this.repository.find(userId, id));
      }
      // Its outcome is unknown: confirmed from the ledger, never resent.
      this.logger.warn(`deposit ${id} outcome unknown: ${safeErrorText(error)}`);
      return wire(await this.repository.find(userId, id));
    }
    if (reply && typeof reply === "object" && Object.keys(reply).sort().join(",") === "response,status" && "status" in reply && "response" in reply) {
      if (reply.status === "ok" && reply.response && typeof reply.response === "object" && Object.keys(reply.response).join(",") === "type" && "type" in reply.response && reply.response.type === "default") return wire(await this.repository.finish(userId, id, "accepted", digest(reply)));
      if (reply.status === "err" && typeof reply.response === "string" && reply.response && !/nonce/i.test(reply.response)) return wire(await this.repository.finish(userId, id, "rejected", digest(reply)));
    }
    return wire(await this.repository.find(userId, id));
  }
  async reconcile(userId: number, id: string) {
    await this.wallets.overview(userId);
    const operation = await this.repository.find(userId, id);
    return this.confirm(operation);
  }
  /** Previously submitted money is still reconciled when copying is disabled
   * or the owner is disabled. This path cannot sign or send anything. */
  async reconcilePending() {
    const operations = await this.repository.claimPending(5);
    for (const operation of operations) {
      // Kept pending for the next bounded check; why, for the log.
      try { await this.confirm(operation, true); } catch (error) { this.logger.warn(`transfer ${operation.id} not confirmed yet: ${safeErrorText(error)}`); }
    }
    return operations.length;
  }
  /**
   * Admin: terminal state for a transfer stuck `unknown`/`accepted`, only after its nonce window
   * and only what a complete ledger read now proves: ledger_receipt → credited;
   * ledger_absent_after_nonce_expiry (only `unknown`) → rejected when every transfer between the
   * accounts is provably another nonce. Unproven → 409, never guessed. Audited in the same tx.
   */
  async resolveByOperator(id: string, input: unknown, actor: RequestUser): Promise<AdminResolvedCopyFunding> {
    const body = parseOr400(adminResolveCopyFundingSchema, input);
    const operation = await this.repository.findAny(id);
    if (!["unknown", "accepted"].includes(operation.status) || !operation.attemptedAt) throw resolveConflict("funding_not_unresolved", "Only a sent transfer whose outcome is unresolved can be resolved");
    if (body.evidence === "ledger_absent_after_nonce_expiry" && operation.status !== "unknown") throw resolveConflict("funding_accepted", "The exchange accepted this transfer; resolve it with its receipt");
    const now = Date.now(), from = Math.max(0, operation.nonce - FUNDING_NONCE_SKEW_MS);
    if (now < operation.nonce + FUNDING_NONCE_EXPIRY_MS) throw resolveConflict("funding_nonce_window_open", "Hyperliquid may still execute this transfer; resolve it after its nonce window");
    const info = operation.network === this.config.value.hyperliquid.wallet.network ? this.walletNetwork?.info ?? this.info : this.info;
    const url = WALLET_NETWORKS[operation.network].infoUrl;
    const rows: HlLedgerUpdate[] = [];
    const detailsOf = new Map<string, unknown>();
    let candidates: string[];
    try {
      // Oldest first; a full page continues from its last time, whose rows come from the next page
      // only (no drop, no double). A page that doesn't advance or isn't ordered is incomplete.
      for (let page = 0, start = from; ; page++) {
        if (page === RESOLVE_LEDGER_MAX_PAGES) throw resolveConflict("funding_ledger_incomplete", "Too many ledger updates to read completely");
        const batch = await info.userNonFundingLedgerUpdates(operation.destination, start, now, "background", PAGE_RANK.fills, url);
        if (batch.length < RESOLVE_LEDGER_PAGE) { rows.push(...batch); break; }
        if (batch.some((row, i) => !Number.isSafeInteger(row.time) || row.time < start || (i > 0 && row.time < batch[i - 1]!.time)))
          throw resolveConflict("funding_ledger_incomplete", "The ledger did not come oldest first");
        const last = batch.at(-1)!.time;
        if (last <= start) throw resolveConflict("funding_ledger_incomplete", "The ledger read did not advance");
        rows.push(...batch.filter((row) => row.time < last));
        start = last;
      }
      candidates = [...new Set(rows.filter((row) => row.delta.type === "internalTransfer" && typeof row.delta.user === "string" && row.delta.user.toLowerCase() === operation.address &&
        typeof row.delta.destination === "string" && row.delta.destination.toLowerCase() === operation.destination).map((row) => row.hash))].sort();
      const wanted = body.evidence === "ledger_receipt" ? candidates.filter((hash) => hash === body.transactionHash) : candidates;
      if (wanted.length > RESOLVE_MAX_CANDIDATES) throw resolveConflict("funding_ledger_incomplete", "Too many transfers between these accounts to prove each");
      for (const hash of wanted) detailsOf.set(hash, /^0x[0-9a-f]{64}$/.test(hash) ? await this.exchange.txDetails(operation.network, hash) : null);
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      this.logger.warn(`transfer ${id} operator resolution read failed: ${safeErrorText(error)}`);
      throw new BadGatewayException("Funding confirmation unavailable");
    }
    const proofOf = (hash: string) => fundingCreditEvidence(operation, hash, detailsOf.get(hash), rows.filter((row) => row.hash === hash));
    let resolved: FundingRow | null;
    if (body.evidence === "ledger_receipt") {
      const proof = detailsOf.has(body.transactionHash) ? proofOf(body.transactionHash) : null;
      if (!proof) throw resolveConflict("funding_receipt_unproven", "That transaction is not this transfer's receipt in the ledger");
      resolved = await this.repository.resolveByOperator(operation, { status: "credited", receipt: proof }, digest(proof), actor, body.reason, body.evidence);
    } else {
      // Fail closed: a transfer that is this one's receipt, or whose details
      // do not prove another nonce, is not proof of absence.
      if (candidates.some((hash) => proofOf(hash))) throw resolveConflict("funding_ledger_has_receipt", "The ledger has this transfer's receipt; resolve it with that receipt");
      if (candidates.some((hash) => !fundingOtherOperation(operation, hash, detailsOf.get(hash))))
        throw resolveConflict("funding_ledger_ambiguous", "The ledger has a transfer between these accounts that may be this one; resolve it by hand");
      const evidenceHash = digest({ source: "operator", evidence: body.evidence, destination: operation.destination, nonce: operation.nonce, ledgerFrom: from, ledgerTo: now, updates: rows.length, others: candidates });
      resolved = await this.repository.resolveByOperator(operation, { status: "rejected" }, evidenceHash, actor, body.reason, body.evidence);
    }
    if (!resolved) throw resolveConflict("funding_not_unresolved", "The transfer was resolved meanwhile");
    this.logger.warn(`transfer ${id} resolved by operator: ${resolved.status} (${body.evidence})`);
    return { id, status: resolved.status === "credited" ? "credited" : "rejected", evidence: body.evidence };
  }
  /** `background` skips a row still backing off (scan_state.backoff, honoured across restarts and
   * replicas); an owner's own lookup is not held back. */
  private async confirm(operation: FundingRow, background = false) {
    const { userId, id } = operation;
    if (!["unknown", "accepted"].includes(operation.status) || !operation.attemptedAt) return wire(operation);
    if (background) {
      // Not cached as a lookup: the row is simply not due yet.
      const backoff = fundingScanSchema.safeParse(operation.scanState).data?.backoff;
      if (backoff && backoff.nextAt > Date.now()) return wire(operation);
    }
    try {
      return await this.lookups.get(id, async () => {
        // Each cycle freezes its upper bound. Cursor/remainder and positive
        // evidence survive restart; late-indexed data is found in a new cycle.
        const parsed = fundingScanSchema.safeParse(operation.scanState);
        const start = Math.max(0, operation.nonce - FUNDING_NONCE_SKEW_MS);
        const cycleEnd = Math.max(start, Date.now());
        const scan: FundingScan = parsed.success ? parsed.data : { version: 1, windows: [{ start, end: cycleEnd }], receipts: [], cycleEnd };
        let current = operation;
        // A failed provider read records backoff on the scan as saved at `current`'s revision.
        const read = async <T>(work: () => Promise<T>): Promise<T> => {
          try { return await work(); } catch (error) { await this.backoff(current, scan, error); throw error; }
        };
        if (!scan.windows.length && !scan.pendingDetails?.length) {
          if (scan.receipts.length === 1) return wire(await this.repository.credit(userId, id, scan.receipts[0]!, digest(scan.receipts[0]), operation.scanRevision));
          return wire(await this.repository.find(userId, id)); // Ambiguous evidence stays pending.
        }
        if (!scan.pendingDetails?.length) {
          const window = scan.windows[0]!, url = WALLET_NETWORKS[operation.network].infoUrl;
          // Wallet-network budget, so a testnet 429 never halves the mainnet budget.
          const info = operation.network === this.config.value.hyperliquid.wallet.network ? this.walletNetwork?.info ?? this.info : this.info;
          const rows = await read(() => info.userNonFundingLedgerUpdates(operation.destination, window.start, window.end, "live", PAGE_RANK.fills, url));
          // A read answered: whatever this pass saves next ends the backoff.
          delete scan.backoff;
          if (rows.length >= MAX_LIST_ITEMS) {
            // Temporal subdivision works whether the provider caps earliest or
            // latest records. Never infer completeness from a capped response.
            if (window.start === window.end || scan.windows.length >= 64) return wire(await this.repository.find(userId, id));
            const mid = Math.floor(window.start + (window.end - window.start) / 2);
            scan.windows.splice(0, 1, { start: mid + 1, end: window.end }, { start: window.start, end: mid });
            await this.repository.saveScan(operation, scan);
            return wire(await this.repository.find(userId, id));
          }
          const candidates = [...new Set(rows.filter((row) => row.delta.type === "internalTransfer" && typeof row.delta.user === "string" && row.delta.user.toLowerCase() === operation.address && typeof row.delta.destination === "string" && row.delta.destination.toLowerCase() === operation.destination && /^0x[0-9a-f]{64}$/.test(row.hash)).map((row) => row.hash))].sort().filter((hash) => !window.afterHash || hash > window.afterHash);
          // Counted before proof: an unproven matching transfer rules out "never executed" until its
          // details prove another operation. Each batch counts only its own hashes.
          const hashes = candidates.slice(0, 5);
          scan.seen = (scan.seen ?? 0) + hashes.length;
          scan.pendingDetails = fundingDetailBatch(hashes, rows);
          if (candidates.length > hashes.length) window.afterHash = hashes.at(-1)!;
          else scan.windows.shift();
          // Commit the original ledger evidence before a separately budgeted
          // explorer read can fail. CAS loss grants no right to continue.
          const checkpoint = await this.repository.saveScan(current, scan);
          if (!checkpoint) return wire(await this.repository.find(userId, id));
          current = checkpoint;
        }
        // The explorer read is live on the shared meter while someone waits on it (an owner's own
        // lookup, or a copy setup waiting for its deposit's credit); the monitor's pass over other
        // transfers is background, so it never takes an order's room.
        const waited = !background || operation.liveSetupId ? "live" : "background";
        while (scan.pendingDetails?.length) {
          const pending = scan.pendingDetails[0]!;
          const details = await read(() => this.exchange.txDetails(operation.network, pending.hash, waited));
          delete scan.backoff; delete scan.explorerFailingSince;
          const proof = fundingCreditEvidence(operation, pending.hash, details, pending.ledger);
          if (proof && !scan.receipts.some((receipt) => digest(receipt) === digest(proof)) && scan.receipts.length < 2) scan.receipts.push(proof);
          // Its details prove another operation between the same accounts
          // (e.g. an earlier deposit): it no longer rules out "never executed".
          if (!proof && scan.seen && fundingOtherOperation(operation, pending.hash, details)) scan.seen -= 1;
          scan.pendingDetails.shift();
          const checkpoint = await this.repository.saveScan(current, scan);
          if (!checkpoint) return wire(await this.repository.find(userId, id));
          current = checkpoint;
        }
        // Unknown, nonce expired before this cycle's read ended, and a complete read shows no transfer
        // source → destination: it can never execute → not executed. CAS on the cycle's scan
        // revision, so a concurrent save (candidate, receipt, credit) wins.
        if (!scan.windows.length && !scan.receipts.length && !scan.seen && operation.status === "unknown" && scan.cycleEnd !== undefined && scan.cycleEnd >= operation.nonce + FUNDING_NONCE_EXPIRY_MS) {
          const evidence = digest({ source: "ledger_absent_after_nonce_expiry", destination: operation.destination, nonce: operation.nonce, ledgerFrom: start, ledgerTo: scan.cycleEnd });
          return wire(await this.repository.notExecuted(current, evidence) ?? await this.repository.find(userId, id));
        }
        const saved = await this.repository.saveScan(current, !scan.windows.length && !scan.receipts.length ? null : scan);
        if (saved && !scan.windows.length && scan.receipts.length === 1) return wire(await this.repository.credit(userId, id, scan.receipts[0]!, digest(scan.receipts[0]), saved.scanRevision));
        return wire(await this.repository.find(userId, id));
      });
    } catch (error) {
      this.logger.warn(`transfer ${id} confirmation unavailable: ${safeErrorText(error)}`);
      throw new BadGatewayException("Funding confirmation unavailable");
    }
  }
  /** Records a failed read's backoff (and explorer outage start) without a new scan revision.
   * Bookkeeping only: its own failure never hides the read's. */
  private async backoff(current: FundingRow, scan: FundingScan, error: unknown) {
    const now = Date.now(), failures = (scan.backoff?.failures ?? 0) + 1, nextAt = now + fundingBackoffMs(failures);
    const explorerFailingSince = classify(error).code === "funding_explorer_unreachable" ? scan.explorerFailingSince ?? now : scan.explorerFailingSince;
    try { await this.repository.saveBackoff(current, { ...structuredClone(scan), backoff: { failures, nextAt }, ...(explorerFailingSince !== undefined ? { explorerFailingSince } : {}) }); }
    catch (saveError) { this.logger.warn(`transfer ${current.id} backoff not kept (${safeErrorText(saveError)}) after: ${safeErrorText(error)}`); }
  }
}
