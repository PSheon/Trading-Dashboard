import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { copyFundingOperations, users, walletWithdrawals } from "@trading-dashboard/shared/database";
import type { WalletWithdrawalInput } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { lockCopyUser } from "../copy/copy-user-lock.js";
import { insertOwnerEvent } from "../copy/copy-runtime.repository.js";

export type WithdrawalRow = typeof walletWithdrawals.$inferSelect;
type Scope = { userId: number; network: "testnet" | "mainnet"; address: string };
const pending = () => inArray(walletWithdrawals.status, ["prepared", "unknown"]);
const owner = (scope: Scope) => and(eq(walletWithdrawals.userId, scope.userId), eq(walletWithdrawals.network, scope.network), eq(walletWithdrawals.address, scope.address));
const conflict = () => new ConflictException({ statusCode: 409, code: "withdrawal_pending", message: "Reconcile the existing withdrawal first" });

@Injectable()
export class WithdrawalRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}
  private locked<T>(userId: number, write: (tx: DbTransaction) => PromiseLike<T>): Promise<T> {
    return this.db.transaction(async tx => { await lockCopyUser(tx, userId); return write(tx); });
  }

  async latest(scope: Scope) {
    const [row] = await this.db.select().from(walletWithdrawals).where(owner(scope)).orderBy(sql`case when ${walletWithdrawals.status} in ('prepared', 'unknown') then 0 else 1 end`, desc(walletWithdrawals.nonce)).limit(1);
    return row ?? null;
  }

  /** The user-row lock also serializes against deletion. Amount, destination,
   * source, network and nonce are immutable after reservation. */
  async reserve(rawScope: Scope, rawInput: WalletWithdrawalInput, importedNonce?: number): Promise<WithdrawalRow> {
    const scope = structuredClone(rawScope), input = structuredClone(rawInput);
    return this.locked(scope.userId, async (tx) => {
      const [user] = await tx.select({ address: users.embeddedWalletAddress, disabledAt: users.disabledAt }).from(users).where(eq(users.id, scope.userId)).for("update");
      if (!user || user.disabledAt || user.address !== scope.address) throw new NotFoundException("Wallet not found");
      if ((await tx.select({ id: copyFundingOperations.id }).from(copyFundingOperations).where(and(
        eq(copyFundingOperations.network, scope.network), eq(copyFundingOperations.address, scope.address),
        inArray(copyFundingOperations.status, ["prepared", "unknown", "accepted"]),
      )).limit(1)).length) throw new ConflictException({ statusCode: 409, code: "funding_pending", message: "Resolve pending strategy funding first" });
      if (importedNonce !== undefined) {
        const [original] = await tx.select().from(walletWithdrawals).where(and(owner(scope), eq(walletWithdrawals.nonce, importedNonce)));
        if (original) {
          if (original.destination !== input.destination || original.amount !== input.amount || original.status === "cancelled") throw conflict();
          if (original.status === "prepared" || (original.status === "unknown" && !original.attemptedAt)) {
            const [updated] = await tx.update(walletWithdrawals).set({ status: "unknown", origin: "legacy", claimedAt: null, updatedAt: new Date() })
              .where(and(eq(walletWithdrawals.id, original.id), inArray(walletWithdrawals.status, ["prepared", "unknown"]), isNull(walletWithdrawals.attemptedAt))).returning();
            if (updated) return updated;
            const [current] = await tx.select().from(walletWithdrawals).where(eq(walletWithdrawals.id, original.id));
            if (!current || current.status === "cancelled") throw conflict();
            return current;
          }
          return original;
        }
      }
      const [active] = await tx.select().from(walletWithdrawals).where(and(owner(scope), pending()));
      if (active) {
        if (importedNonce !== undefined || active.destination !== input.destination || active.amount !== input.amount) throw conflict();
        return active;
      }
      const [latest] = await tx.select({ nonce: walletWithdrawals.nonce }).from(walletWithdrawals).where(owner(scope)).orderBy(desc(walletWithdrawals.nonce)).limit(1);
      const [funding] = await tx.select({ nonce: copyFundingOperations.nonce }).from(copyFundingOperations)
        .where(and(eq(copyFundingOperations.network, scope.network), eq(copyFundingOperations.address, scope.address))).orderBy(desc(copyFundingOperations.nonce)).limit(1);
      const nonce = importedNonce ?? Math.max(Date.now(), (latest?.nonce ?? 0) + 1, (funding?.nonce ?? 0) + 1);
      const [row] = await tx.insert(walletWithdrawals).values({ id: randomUUID(), ...scope, ...input, nonce, origin: importedNonce === undefined ? "client" : "legacy", status: importedNonce === undefined ? "prepared" : "unknown" }).returning();
      return row!;
    });
  }

  async find(userId: number, id: string): Promise<WithdrawalRow> {
    const [row] = await this.db.select().from(walletWithdrawals).where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId)));
    if (!row) throw new NotFoundException("Withdrawal not found");
    return row;
  }

  async claim(userId: number, id: string) {
    const [claimed] = await this.locked(userId, tx => tx.update(walletWithdrawals).set({ status: "unknown", claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.status, "prepared"))).returning());
    return { row: claimed ?? await this.find(userId, id), claimed: Boolean(claimed) };
  }

  async cancel(userId: number, id: string) {
    const [cancelled] = await this.locked(userId, tx => tx.update(walletWithdrawals).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), or(eq(walletWithdrawals.status, "prepared"), and(eq(walletWithdrawals.status, "unknown"), eq(walletWithdrawals.origin, "client"), isNull(walletWithdrawals.attemptedAt))))).returning());
    const row = cancelled ?? await this.find(userId, id);
    if (row.status !== "cancelled") throw conflict();
    return row;
  }

  async beginSubmit(userId: number, id: string) {
    // The exchange budget can wait. Revalidate the authoritative owner at the
    // durable attempt boundary, serialized against disablement and replacement.
    return this.locked(userId, async (tx) => {
      const [user] = await tx.select({ address: users.embeddedWalletAddress, disabledAt: users.disabledAt })
        .from(users).where(eq(users.id, userId)).for("share");
      const [operation] = await tx.select().from(walletWithdrawals)
        .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId)));
      if (!operation) throw new NotFoundException("Withdrawal not found");
      if (!user || user.disabledAt || user.address !== operation.address) throw new ConflictException("Wallet is unavailable or identity changed");
      const [row] = await tx.update(walletWithdrawals).set({ attemptedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.origin, "client"), eq(walletWithdrawals.status, "unknown"), sql`${walletWithdrawals.claimedAt} is not null`, isNull(walletWithdrawals.attemptedAt))).returning();
      return row ?? null;
    });
  }

  async restoreUnsent(userId: number, id: string) {
    await this.locked(userId, tx => tx.update(walletWithdrawals).set({ status: "prepared", claimedAt: null, updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.origin, "client"), eq(walletWithdrawals.status, "unknown"), isNull(walletWithdrawals.attemptedAt))));
  }

  /** The exchange's answer to a hub withdrawal; the owner's live feed gets
   * it once (the guarded update moves an `unknown` row only once). */
  async finish(userId: number, id: string, status: "accepted" | "rejected", evidenceHash: string) {
    const [accepted] = await this.locked(userId, async tx => {
      const rows = await tx.update(walletWithdrawals).set({ status, evidenceHash, updatedAt: new Date() })
        .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.status, "unknown"))).returning();
      const row = rows[0];
      if (row) await insertOwnerEvent(tx, userId, null, "wallet_withdrawal", { mode: "hub", network: row.network, status, amount: row.amount, destination: row.destination });
      return rows;
    });
    return accepted ?? this.find(userId, id);
  }
}
