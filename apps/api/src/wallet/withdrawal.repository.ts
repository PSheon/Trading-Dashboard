import { randomUUID } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { users, walletWithdrawals } from "@trading-dashboard/shared/database";
import type { WalletWithdrawalInput } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";

export type WithdrawalRow = typeof walletWithdrawals.$inferSelect;
type Scope = { userId: number; network: "testnet" | "mainnet"; address: string };
const pending = () => inArray(walletWithdrawals.status, ["prepared", "unknown"]);
const owner = (scope: Scope) => and(eq(walletWithdrawals.userId, scope.userId), eq(walletWithdrawals.network, scope.network), eq(walletWithdrawals.address, scope.address));
const conflict = () => new ConflictException({ statusCode: 409, code: "withdrawal_pending", message: "Reconcile the existing withdrawal first" });

@Injectable()
export class WithdrawalRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  async latest(scope: Scope) {
    const [row] = await this.db.select().from(walletWithdrawals).where(owner(scope)).orderBy(sql`case when ${walletWithdrawals.status} in ('prepared', 'unknown') then 0 else 1 end`, desc(walletWithdrawals.nonce)).limit(1);
    return row ?? null;
  }

  /** The user-row lock also serializes against deletion. Amount, destination,
   * source, network and nonce are immutable after reservation. */
  async reserve(scope: Scope, input: WalletWithdrawalInput, importedNonce?: number): Promise<WithdrawalRow> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx.select({ address: users.embeddedWalletAddress, disabledAt: users.disabledAt }).from(users).where(eq(users.id, scope.userId)).for("update");
      if (!user || user.disabledAt || user.address !== scope.address) throw new NotFoundException("Wallet not found");
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
      const nonce = importedNonce ?? Math.max(Date.now(), (latest?.nonce ?? 0) + 1);
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
    const [claimed] = await this.db.update(walletWithdrawals).set({ status: "unknown", claimedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.status, "prepared"))).returning();
    return { row: claimed ?? await this.find(userId, id), claimed: Boolean(claimed) };
  }

  async cancel(userId: number, id: string) {
    const [cancelled] = await this.db.update(walletWithdrawals).set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), or(eq(walletWithdrawals.status, "prepared"), and(eq(walletWithdrawals.status, "unknown"), eq(walletWithdrawals.origin, "client"), isNull(walletWithdrawals.attemptedAt))))).returning();
    const row = cancelled ?? await this.find(userId, id);
    if (row.status !== "cancelled") throw conflict();
    return row;
  }

  async beginSubmit(userId: number, id: string) {
    const [row] = await this.db.update(walletWithdrawals).set({ attemptedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.origin, "client"), eq(walletWithdrawals.status, "unknown"), sql`${walletWithdrawals.claimedAt} is not null`, isNull(walletWithdrawals.attemptedAt))).returning();
    return row ?? null;
  }

  async restoreUnsent(userId: number, id: string) {
    await this.db.update(walletWithdrawals).set({ status: "prepared", claimedAt: null, updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.origin, "client"), eq(walletWithdrawals.status, "unknown"), isNull(walletWithdrawals.attemptedAt)));
  }

  async finish(userId: number, id: string, status: "accepted" | "rejected", evidenceHash: string) {
    const [accepted] = await this.db.update(walletWithdrawals).set({ status, evidenceHash, updatedAt: new Date() })
      .where(and(eq(walletWithdrawals.id, id), eq(walletWithdrawals.userId, userId), eq(walletWithdrawals.status, "unknown"))).returning();
    return accepted ?? this.find(userId, id);
  }
}
