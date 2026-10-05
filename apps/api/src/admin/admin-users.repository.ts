import { Inject, Injectable } from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import type { AdminUser, AdminUsersQuery, PatchAdminUserRequest } from "@trading-dashboard/shared/contracts";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import type { DbTransaction } from "../db/unit-of-work.js";
import { recordAdminAudit } from "../common/audit/admin-audit.js";
import type { RequestUser } from "../common/auth/current-user.js";
import { lockCopyUser } from "../copy/copy-user-lock.js";

/** `\`, `%` and `_` taken literally in a LIKE pattern (escape char `\`). */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

const adminUserColumns = {
  id: users.id,
  email: users.email,
  walletAddress: users.walletAddress,
  displayName: users.displayName,
  role: users.role,
  locale: users.locale,
  createdAt: users.createdAt,
  lastLoginAt: users.lastLoginAt,
  disabledAt: users.disabledAt,
  // Spelled out: drizzle renders columns unqualified in a single-table
  // select, so `${users.id}` inside the subquery would bind to the inner
  // table's "id".
  favorites: sql<number>`(select count(*)::int from "user_favorites" uf where uf."user_id" = "users"."id")`,
  telegramEnabled: sql<boolean>`exists (select 1 from "notification_channels" nc where nc."user_id" = "users"."id" and nc."kind" = 'telegram' and nc."enabled")`,
};

type AdminUserRow = Omit<AdminUser, "disabled"> & { disabledAt: Date | null };

function toAdminUser(row: AdminUserRow): AdminUser {
  const { disabledAt, ...rest } = row;
  return { ...rest, favorites: Number(row.favorites), disabled: disabledAt !== null };
}

/** Admin projections and writes; the service owns policy and the transaction. */
@Injectable()
export class AdminUsersRepository {
  constructor(@Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb) {}

  lockCopyOwner(tx: DbTransaction, id: number) { return lockCopyUser(tx, id); }

  async list(query: AdminUsersQuery) {
    // Account-deletion tombstones are not people (docs/account-deletion.md).
    const conditions: SQL[] = [isNull(users.deletedAt)];
    if (query.role) conditions.push(eq(users.role, query.role));
    const q = query.q?.trim();
    if (q) {
      const pattern = `%${escapeLike(q)}%`;
      conditions.push(
        or(
          sql`${users.email} ilike ${pattern} escape '\\'`,
          sql`${users.walletAddress} ilike ${pattern} escape '\\'`,
          sql`${users.displayName} ilike ${pattern} escape '\\'`,
        )!,
      );
    }
    const where = conditions.length ? and(...conditions) : undefined;

    const [rows, [{ total }]] = await Promise.all([
      this.db
        .select(adminUserColumns)
        .from(users)
        .where(where)
        .orderBy(desc(users.createdAt), desc(users.id))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(users).where(where),
    ]);
    return { total, items: rows.map(toAdminUser) };
  }

  /** Lock in id order before the target row to serialize last-admin decisions. */
  lockEnabledAdmins(tx: DbTransaction) {
    return tx.select({ id: users.id }).from(users)
      .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
      .orderBy(asc(users.id)).for("update");
  }

  async lockUser(tx: DbTransaction, id: number) {
    const [row] = await tx.select().from(users).where(and(eq(users.id, id), isNull(users.deletedAt))).for("update");
    return row;
  }

  /** Apply a validated patch after lockUser; use the same tx for its audit record. */
  async patch(tx: DbTransaction, id: number, request: PatchAdminUserRequest) {
    const set: Partial<typeof users.$inferInsert> = {};
    if (request.role !== undefined) set.role = request.role;
    if (request.disabled === true) set.disabledAt = sql`now()` as unknown as Date;
    if (request.disabled === false) set.disabledAt = null;
    if (Object.keys(set).length > 0) await tx.update(users).set(set).where(eq(users.id, id));
    const [row] = await tx.select(adminUserColumns).from(users).where(eq(users.id, id));
    return toAdminUser(row);
  }

  /** Persist the audit event in the caller's user-update transaction. */
  recordUpdate(tx: DbTransaction, actor: RequestUser | null, id: number,
    before: Pick<AdminUser, "role" | "disabled">, after: Pick<AdminUser, "role" | "disabled">) {
    return recordAdminAudit(tx, actor, "user.update", String(id), before, after);
  }
}
