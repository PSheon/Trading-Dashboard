import { BadGatewayException, BadRequestException, ConflictException, Injectable, Logger } from "@nestjs/common";
import type { RequestUser } from "../common/auth/current-user.js";
import { parseOr400 } from "../common/http/validation.js";
import { createHash } from "node:crypto";
import { verifyTypedData } from "viem";
import { WALLET_NETWORKS, WITHDRAWAL_NONCE_WINDOW_MS, adminResolveWithdrawalSchema, withdraw3TypedData, walletWithdrawalImportSchema, walletWithdrawalInputSchema, withdrawalUnits, type AdminResolvedWithdrawal, type AdminUnresolvedWithdrawals, type WalletWithdrawal } from "@trading-dashboard/shared/contracts";
import { AppConfig } from "../config/app-config.js";
import { HyperliquidInfoClient } from "../hyperliquid/hyperliquid-info.client.js";
import { PAGE_RANK } from "../hyperliquid/request-budgeter.service.js";
import { TtlCache } from "../traders/ttl-cache.js";
import { BusyException } from "../traders/busy.js";
import { BUSY_RETRY_AFTER_MS, isBusyError } from "../traders/traders.controller.js";
import { WalletService } from "./wallet.service.js";
import { WithdrawalRepository, type WithdrawalRow } from "./withdrawal.repository.js";
import { WithdrawalExchangeClient } from "./withdrawal-exchange.client.js";
import type { HlLedgerUpdate } from "../hyperliquid/types.js";

/** A ledger read returns at most this many updates; a full page means
 * there may be more after it (read on from its last time). */
const LEDGER_PAGE = 500;
/** Pages read before an operator resolution gives up (too much activity to
 * prove an absence; the operator retries later or resolves by hand in the
 * database with the evidence). */
const LEDGER_MAX_PAGES = 20;

const wire = (row: WithdrawalRow): WalletWithdrawal => ({ id: row.id, network: row.network, address: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce, status: row.status, canCancel: row.status === "prepared" || (row.status === "unknown" && row.origin === "client" && !row.attemptedAt), createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() });

const evidenceHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Privy signs in the browser. The API verifies that exact immutable intent,
 * makes one submission, and persists outcome evidence without the signature. */
@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger("Withdrawal");
  private readonly lookupCache = new TtlCache<string | null>(30_000);
  /** One line per state change of a withdrawal (the request id is added by
   * the logger): what an incident needs when the database row is not enough.
   * Never the signature or the destination address. */
  private note(event: string, row: Pick<WithdrawalRow, "id" | "userId" | "network" | "nonce" | "status" | "amount"> & { evidenceHash?: string | null }, extra: Record<string, unknown> = {}, level: "log" | "warn" = "log") {
    this.logger[level]({ event, withdrawalId: row.id, userId: row.userId, network: row.network, nonce: row.nonce, status: row.status, amount: row.amount,
      ...(row.evidenceHash ? { evidenceHash: row.evidenceHash.slice(0, 16) } : {}), ...extra });
  }
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
    const row = await this.repository.reserve(await this.scope(userId), parsed.data);
    this.note("withdrawal.reserved", row);
    return wire(row);
  }
  async import(userId: number, body: unknown) {
    const parsed = walletWithdrawalImportSchema.safeParse(body);
    if (!parsed.success || parsed.data.nonce > Date.now() + 5_000) throw new BadRequestException("Invalid legacy withdrawal");
    const { nonce, ...input } = parsed.data;
    // Old unknown metadata must survive upgrades, including records older than
    // the upstream ledger window. Never mint a fresh nonce for an import.
    const row = await this.repository.reserve(await this.scope(userId), input, nonce);
    this.note("withdrawal.imported", row, { origin: row.origin });
    return wire(row);
  }
  async claim(userId: number, id: string) {
    await this.own(userId, id);
    const claim = await this.repository.claim(userId, id);
    this.note("withdrawal.claimed", claim.row, { claimed: claim.claimed });
    return { operation: wire(claim.row), claimed: claim.claimed };
  }
  async cancel(userId: number, id: string) {
    await this.own(userId, id);
    const row = await this.repository.cancel(userId, id);
    this.note("withdrawal.cancelled", row);
    return wire(row);
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
      this.note("withdrawal.submit.deferred", operation, { reason: "exchange_budget_busy" }, "warn");
      throw new BusyException(BUSY_RETRY_AFTER_MS);
    }
    const identityCheckedAt = Date.now();
    const claimed = await this.repository.beginSubmit(userId, id);
    if (!claimed) return wire(await this.repository.find(userId, id));
    this.note("withdrawal.submit.started", claimed);
    let reply: unknown;
    try { reply = await this.exchange.send(claimed, signature, () => {
      const now = Date.now();
      if (!Number.isSafeInteger(identityCheckedAt) || now < identityCheckedAt || now - identityCheckedAt > 5000 ||
        claimed.network !== this.network || claimed.address !== operation.address || claimed.destination !== operation.destination ||
        claimed.amount !== operation.amount || claimed.nonce !== operation.nonce) throw new ConflictException('withdrawal_identity_evidence_expired');
    }); }
    catch (error) {
      // Sent or not, the outcome is unknown: never resent, reconciled by nonce.
      this.note("withdrawal.submit.failed", claimed, { error: error instanceof Error ? error.name : "unknown", outcome: "unknown" }, "warn");
      return wire(await this.repository.find(userId, id));
    }
    if (reply && typeof reply === "object" && Object.keys(reply).length === 2 && "status" in reply && "response" in reply) {
      if (reply.status === "ok" && reply.response && typeof reply.response === "object" && "type" in reply.response && reply.response.type === "default" && Object.keys(reply.response).length === 1) {
        const row = await this.repository.finish(userId, id, "accepted", evidenceHash(reply));
        this.note("withdrawal.submit.result", row, { exchange: "ok" });
        return wire(row);
      }
      if (reply.status === "err" && typeof reply.response === "string" && reply.response.length > 0 && !/nonce/i.test(reply.response)) {
        const row = await this.repository.finish(userId, id, "rejected", evidenceHash(reply));
        this.note("withdrawal.submit.result", row, { exchange: "err" }, "warn");
        return wire(row);
      }
    }
    const row = await this.repository.find(userId, id);
    this.note("withdrawal.submit.result", row, { exchange: "unrecognised", outcome: "unknown" }, "warn");
    return wire(row);
  }
  async reconcile(userId: number, id: string) {
    const operation = await this.own(userId, id);
    if (operation.status !== "unknown") return wire(operation);
    let found: string | null;
    try {
      found = await this.lookupCache.get(id, async () => {
        const rows = await this.info.userNonFundingLedgerUpdates(operation.address, Math.max(0, operation.nonce - 60_000), Date.now(), "background", PAGE_RANK.fills, this.config.value.hyperliquid.wallet.infoUrl);
        return ledgerMatch(operation, rows, Date.now());
      });
    } catch (error) {
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      throw new BadGatewayException("Withdrawal status unavailable");
    }
    if (!found) return wire(await this.repository.find(userId, id));
    const row = await this.repository.finish(userId, id, "accepted", found);
    this.note("withdrawal.reconciled", row, { source: "ledger" });
    return wire(row);
  }

  /** Admin: every main-wallet withdrawal whose outcome is unknown. */
  async unresolved(): Promise<AdminUnresolvedWithdrawals> {
    const rows = await this.repository.unresolved();
    return { items: rows.map(({ row, email }) => ({
      id: row.id, userId: row.userId, email, network: row.network, address: row.address, destination: row.destination, amount: row.amount, nonce: row.nonce,
      attempted: Boolean(row.attemptedAt), createdAt: row.createdAt.toISOString(), resolvableAt: new Date(row.nonce + WITHDRAWAL_NONCE_WINDOW_MS).toISOString(),
    })) };
  }

  /**
   * Admin (users.manage): gives an unknown withdrawal its terminal state so
   * the address can withdraw and fund again. Only once Hyperliquid's nonce
   * window has passed (the signed action can no longer execute), and only
   * from a complete ledger read made now: a matching withdraw → accepted;
   * none → not_executed. Audited (wallet.withdrawal.resolve) with the
   * operator's reason, in the same transaction.
   */
  async resolveByOperator(id: string, input: unknown, actor: RequestUser): Promise<AdminResolvedWithdrawal> {
    const { reason } = parseOr400(adminResolveWithdrawalSchema, input);
    const operation = await this.repository.findAny(id);
    if (operation.status !== "unknown") throw new ConflictException({ statusCode: 409, code: "withdrawal_not_unknown", message: "Only a withdrawal whose outcome is unknown can be resolved" });
    const now = Date.now();
    if (now < operation.nonce + WITHDRAWAL_NONCE_WINDOW_MS) throw new ConflictException({ statusCode: 409, code: "withdrawal_nonce_window_open", message: "Hyperliquid may still execute this withdrawal; resolve it after its nonce window" });
    let rows: HlLedgerUpdate[] = [];
    try {
      let start = Math.max(0, operation.nonce - 60_000);
      for (let page = 0; ; page++) {
        if (page === LEDGER_MAX_PAGES) throw new ConflictException({ statusCode: 409, code: "withdrawal_ledger_incomplete", message: "Too many ledger updates to prove the withdrawal absent" });
        const batch = await this.info.userNonFundingLedgerUpdates(operation.address, start, now, "background", PAGE_RANK.fills, this.config.value.hyperliquid.wallet.infoUrl);
        rows = rows.concat(batch);
        if (batch.length < LEDGER_PAGE) break;
        const last = Math.max(...batch.map((row) => row.time));
        if (!Number.isSafeInteger(last) || last < start) throw new ConflictException({ statusCode: 409, code: "withdrawal_ledger_incomplete", message: "The ledger read did not advance" });
        start = last + 1;
      }
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      if (isBusyError(error)) throw new BusyException(BUSY_RETRY_AFTER_MS);
      throw new BadGatewayException("Withdrawal status unavailable");
    }
    const match = ledgerMatch(operation, rows, now);
    // Fail closed: a withdraw with this nonce that does not match exactly
    // (amount, fee, hash format) is not proof of absence.
    if (!match && rows.some(row => row.delta.type === 'withdraw' && typeof row.delta.nonce === 'number' &&
      (BigInt(Math.trunc(row.delta.nonce)) === BigInt(operation.nonce) || BigInt(Math.trunc(row.delta.nonce)) === BigInt(operation.nonce) * 1000n)))
      throw new ConflictException({ statusCode: 409, code: "withdrawal_ledger_ambiguous", message: "The ledger has a withdrawal with this nonce that does not match; resolve it by hand" });
    const evidence = match ? "ledger_match" as const : "ledger_absent_after_nonce_window" as const;
    const status = match ? "accepted" as const : "not_executed" as const;
    const hash = match ?? evidenceHash({ source: "operator", evidence, address: operation.address, nonce: operation.nonce, ledgerFrom: Math.max(0, operation.nonce - 60_000), ledgerTo: now, updates: rows.length });
    const resolved = await this.repository.resolve(operation, status, hash, actor, reason, evidence);
    if (!resolved) throw new ConflictException({ statusCode: 409, code: "withdrawal_not_unknown", message: "The withdrawal was resolved meanwhile" });
    this.note("withdrawal.resolved", resolved, { evidence, actorUserId: actor.kind === "user" ? actor.id : null, ledgerUpdates: rows.length }, "warn");
    return { id, status, evidence };
  }
}

/** The ledger's withdraw for this operation (its nonce, in ms or µs, and
 * its amount with or without the fee), as evidence; null when absent. */
function ledgerMatch(operation: WithdrawalRow, rows: HlLedgerUpdate[], now: number): string | null {
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
}
