import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";
import { copyFundingInputSchema, usdSendTypedData, WALLET_NETWORKS, type CopyFunding } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient, MAX_LIST_ITEMS } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import { BusyException } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS } from "../traders/traders.controller.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { CopyWalletService } from "./copy-wallet.service.js";
import { CopyFundingRepository, type FundingRow } from "./copy-funding.repository.js";
import { CopyFundingExchangeClient } from "./copy-funding-exchange.client.js";
import { fundingCreditEvidence } from "./copy-funding-evidence.js";
import { FUNDING_NONCE_SKEW_MS, fundingScanSchema, type FundingScan } from "./copy-funding-scan.js";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const wire = (row: FundingRow): CopyFunding => ({ id: row.id, accountId: row.accountId, strategyId: row.strategyId,
  network: row.network, address: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce,
  status: row.status, canCancel: ["prepared", "unknown"].includes(row.status) && !row.attemptedAt,
  transactionHash: row.transactionHash, creditedAmount: row.creditedAmount, fee: row.fee, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

/** Testnet setup funds never become paper collateral. Mainnet stays disabled
 * until the complete live trading lifecycle is connected and verified. */
@Injectable()
export class CopyFundingService {
  private readonly lookups = new TtlCache<CopyFunding>(15_000);
  constructor(private readonly config: AppConfig, private readonly repository: CopyFundingRepository,
    private readonly wallets: CopyWalletService, private readonly exchange: CopyFundingExchangeClient, private readonly info: HyperliquidInfoClient) {}
  private get available() { return this.config.value.hyperliquid.wallet.network === "testnet" && this.config.value.copy.mode !== "disabled"; }
  private assertAvailable() { if (!this.available) throw new ServiceUnavailableException("Strategy funding is available on testnet only"); }
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
  async reserve(userId: number, accountId: string, body: unknown) {
    this.assertAvailable();
    const parsed = copyFundingInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid funding request");
    await this.verified(userId, accountId);
    return wire(await this.repository.reserve(userId, accountId, this.config.value.hyperliquid.wallet.network, parsed.data));
  }
  async claim(userId: number, id: string) {
    this.assertAvailable();
    const row = await this.repository.find(userId, id);
    await this.verified(userId, row.accountId);
    const claimed = await this.repository.claim(userId, id);
    return { operation: wire(claimed.row), claimed: claimed.claimed };
  }
  async cancel(userId: number, id: string) { await this.wallets.overview(userId); return wire(await this.repository.cancel(userId, id)); }
  async submit(userId: number, id: string, signature: string) {
    this.assertAvailable();
    const row = await this.repository.find(userId, id);
    if (row.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("Funding network changed");
    let valid = false;
    try { valid = /^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature) && await verifyTypedData({ ...usdSendTypedData(WALLET_NETWORKS[row.network], row.destination, row.amount, row.nonce), address: row.address as `0x${string}`, signature: signature as `0x${string}` }); } catch { /* Never log signing inputs. */ }
    if (!valid) throw new BadRequestException("Invalid funding signature");
    if (row.status !== "unknown" || !row.claimedAt) return wire(row);
    if (row.attemptedAt) return wire(row);
    try {
      if (!await this.exchange.available(row)) {
        await this.repository.restoreUnsent(userId, id);
        throw new ConflictException("Insufficient transferable USDC");
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
    const attempt = await this.repository.beginSubmit(userId, id);
    if (!attempt) return wire(await this.repository.find(userId, id));
    let reply: unknown;
    try { reply = await this.exchange.send(attempt, signature, () => {
      const now = Date.now();
      this.assertAvailable();
      if (!Number.isSafeInteger(identityCheckedAt) || now < identityCheckedAt || now - identityCheckedAt > 5000 ||
        account.id !== attempt.accountId || account.address !== attempt.destination || account.network !== attempt.network ||
        attempt.network !== this.config.value.hyperliquid.wallet.network) throw new ConflictException("funding_identity_evidence_expired");
    }); } catch { return wire(await this.repository.find(userId, id)); }
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
      try { await this.confirm(operation); } catch { /* Keep the durable intent pending for the next bounded check. */ }
    }
    return operations.length;
  }
  private async confirm(operation: FundingRow) {
    const { userId, id } = operation;
    if (!["unknown", "accepted"].includes(operation.status) || !operation.attemptedAt) return wire(operation);
    try {
      return await this.lookups.get(id, async () => {
        // Each cycle freezes its upper bound. Cursor/remainder and positive
        // evidence survive restart; late-indexed data is found in a new cycle.
        const parsed = fundingScanSchema.safeParse(operation.scanState);
        const start = Math.max(0, operation.nonce - FUNDING_NONCE_SKEW_MS);
        const scan: FundingScan = parsed.success ? parsed.data : { version: 1, windows: [{ start, end: Math.max(start, Date.now()) }], receipts: [] };
        if (!scan.windows.length) {
          if (scan.receipts.length === 1) return wire(await this.repository.credit(userId, id, scan.receipts[0]!, digest(scan.receipts[0]), operation.scanRevision));
          return wire(await this.repository.find(userId, id)); // Ambiguous evidence stays pending.
        }
        const window = scan.windows[0]!, url = WALLET_NETWORKS[operation.network].infoUrl;
        const rows = await this.info.userNonFundingLedgerUpdates(operation.destination, window.start, window.end, "live", PAGE_RANK.fills, url);
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
        const hashes = candidates.slice(0, 5);
        for (const hash of hashes) {
          const details = await this.exchange.txDetails(operation.network, hash);
          const proof = fundingCreditEvidence(operation, hash, details, rows);
          if (proof && !scan.receipts.some((receipt) => digest(receipt) === digest(proof)) && scan.receipts.length < 2) scan.receipts.push(proof);
        }
        if (candidates.length > hashes.length) window.afterHash = hashes.at(-1)!;
        else scan.windows.shift();
        const saved = await this.repository.saveScan(operation, !scan.windows.length && !scan.receipts.length ? null : scan);
        if (saved && !scan.windows.length && scan.receipts.length === 1) return wire(await this.repository.credit(userId, id, scan.receipts[0]!, digest(scan.receipts[0]), saved.scanRevision));
        return wire(await this.repository.find(userId, id));
      });
    } catch { throw new BadGatewayException("Funding confirmation unavailable"); }
  }
}
