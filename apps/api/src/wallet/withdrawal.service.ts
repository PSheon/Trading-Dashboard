import { BadGatewayException, BadRequestException, ConflictException, Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";
import { WALLET_NETWORKS, withdraw3TypedData, walletWithdrawalImportSchema, walletWithdrawalInputSchema, withdrawalUnits, type WalletWithdrawal } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { BusyException } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS, isBusyError } from "../traders/traders.controller.js";
import { WalletService } from "./wallet.service.js";
import { WithdrawalRepository, type WithdrawalRow } from "./withdrawal.repository.js";
import { WithdrawalExchangeClient } from "./withdrawal-exchange.client.js";

const wire = (row: WithdrawalRow): WalletWithdrawal => ({ id: row.id, network: row.network, address: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce, status: row.status, canCancel: row.status === "prepared" || (row.status === "unknown" && row.origin === "client" && !row.attemptedAt), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

const evidenceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Privy signs in the browser. The API verifies that exact immutable intent,
 * makes one submission, and persists outcome evidence without the signature. */
@Injectable()
export class WithdrawalService {
  private readonly lookupCache = new TtlCache<string | null>(30_000);
  constructor(private readonly config: AppConfig, private readonly wallet: WalletService, private readonly repository: WithdrawalRepository, private readonly info: HyperliquidInfoClient, private readonly exchange: WithdrawalExchangeClient) {}
  private get network() { return this.config.value.hyperliquid.wallet.network; }
  private async scope(userId: number) {
    const address = await this.wallet.address(userId);
    if (!address) throw new BadRequestException("Wallet is not ready");
    return { userId, network: this.network, address };
  }
  private async own(userId: number, id: string) {
    const row = await this.repository.find(userId, id);
    const scope = await this.scope(userId);
    if (row.network !== scope.network || row.address !== scope.address) throw new ConflictException("Wallet network or identity changed");
    return row;
  }
  async current(userId: number) {
    const address = await this.wallet.address(userId);
    if (!address) return null;
    const row = await this.repository.latest({ userId, network: this.network, address });
    if (!row) return null;
    if (row.status === "unknown") {
      // Polling may confirm a positive match. Read failures still expose the
      // durable pending state; manual reconciliation reports the retry error.
      try { return await this.reconcile(userId, row.id); } catch { return wire(row); }
    }
    return wire(row);
  }
  async reserve(userId: number, body: unknown) {
    const parsed = walletWithdrawalInputSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("Invalid withdrawal");
    return wire(await this.repository.reserve(await this.scope(userId), parsed.data));
  }
  async import(userId: number, body: unknown) {
    const parsed = walletWithdrawalImportSchema.safeParse(body);
    if (!parsed.success || parsed.data.nonce > Date.now() + 5_000) throw new BadRequestException("Invalid legacy withdrawal");
    const { nonce, ...input } = parsed.data;
    // Old unknown metadata must survive upgrades, including records older than
    // the upstream ledger window. Never mint a fresh nonce for an import.
    return wire(await this.repository.reserve(await this.scope(userId), input, nonce));
  }
  async claim(userId: number, id: string) {
    await this.own(userId, id);
    const claim = await this.repository.claim(userId, id);
    return { operation: wire(claim.row), claimed: claim.claimed };
  }
  async cancel(userId: number, id: string) {
    await this.own(userId, id);
    return wire(await this.repository.cancel(userId, id));
  }
  async submit(userId: number, id: string, signature: string) {
    const operation = await this.own(userId, id);
    let valid = false;
    try {
      valid = /^0x[0-9a-fA-F]{128}(?:00|01|1b|1c)$/i.test(signature) && await verifyTypedData({
        ...withdraw3TypedData(WALLET_NETWORKS[operation.network], operation.destination, operation.amount, operation.nonce),
        address: operation.address as `0x${string}`, signature: signature as `0x${string}`,
      });
    } catch { /* Invalid signatures never reach the exchange or logs. */ }
    if (!valid) throw new BadRequestException("Invalid withdrawal signature");
    if (operation.status === "accepted" || operation.status === "rejected") return wire(operation);
    if (operation.origin !== "client" || operation.status !== "unknown" || !operation.claimedAt) throw new ConflictException("Withdrawal is not eligible for submission");
    if (operation.attemptedAt) return wire(operation);
    try { await this.exchange.acquire(); }
    catch {
      // No exchange bytes have been sent. The CAS cannot release an operation
      // whose competing request already started its actual attempt.
      await this.repository.restoreUnsent(userId, id);
      throw new BusyException(BUSY_RETRY_AFTER_MS);
    }
    const identityCheckedAt = Date.now();
    const claimed = await this.repository.beginSubmit(userId, id);
    if (!claimed) return wire(await this.repository.find(userId, id));
    let reply: unknown;
    try { reply = await this.exchange.send(claimed, signature, () => {
      const now = Date.now();
      if (!Number.isSafeInteger(identityCheckedAt) || now < identityCheckedAt || now - identityCheckedAt > 5000 ||
        claimed.network !== this.network || claimed.address !== operation.address || claimed.destination !== operation.destination ||
        claimed.amount !== operation.amount || claimed.nonce !== operation.nonce) throw new ConflictException('withdrawal_identity_evidence_expired');
    }); }
    catch { return wire(await this.repository.find(userId, id)); }
    if (reply && typeof reply === "object" && Object.keys(reply).length === 2 && "status" in reply && "response" in reply) {
      if (reply.status === "ok" && reply.response && typeof reply.response === "object" && "type" in reply.response && reply.response.type === "default" && Object.keys(reply.response).length === 1) {
        return wire(await this.repository.finish(userId, id, "accepted", evidenceHash(reply)));
      }
      if (reply.status === "err" && typeof reply.response === "string" && reply.response.length > 0 && !/nonce/i.test(reply.response)) {
        return wire(await this.repository.finish(userId, id, "rejected", evidenceHash(reply)));
      }
    }
    return wire(await this.repository.find(userId, id));
  }
  async reconcile(userId: number, id: string) {
    const operation = await this.own(userId, id);
    if (operation.status !== "unknown") return wire(operation);
    let found: string | null;
    try {
      found = await this.lookupCache.get(id, async () => {
        const now = Date.now();
        const rows = await this.info.userNonFundingLedgerUpdates(operation.address, Math.max(0, operation.nonce - 60_000), now, "background", PAGE_RANK.fills, this.config.value.hyperliquid.wallet.infoUrl);
        const match = rows.find((row) => {
          if (row.delta.type !== "withdraw" || typeof row.delta.nonce !== "number" || !Number.isSafeInteger(row.delta.nonce) || !Number.isSafeInteger(row.time) || row.time < operation.nonce - 60_000 || row.time > now + 5_000 || !/^0x[0-9a-fA-F]{64}$/.test(row.hash) || typeof row.delta.usdc !== "string") return false;
          // Live ledger samples encode the action's millisecond nonce in
          // microseconds. Retain compatibility with the unscaled format too.
          const nonce = BigInt(row.delta.nonce);
          if (nonce !== BigInt(operation.nonce) && nonce !== BigInt(operation.nonce) * 1000n) return false;
          try {
            const amount = withdrawalUnits(operation.amount), usdc = withdrawalUnits(row.delta.usdc);
            return usdc === amount || (typeof row.delta.fee === "string" && usdc + withdrawalUnits(row.delta.fee) === amount);
          } catch { return false; }
        });
        return match ? evidenceHash({ source: "ledger", hash: match.hash, nonce: match.delta.nonce, amount: match.delta.usdc, fee: match.delta.fee }) : null;
      });
    } catch (error) {
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      throw new BadGatewayException("Withdrawal status unavailable");
    }
    return wire(found ? await this.repository.finish(userId, id, "accepted", found) : await this.repository.find(userId, id));
  }
}
