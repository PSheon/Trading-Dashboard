import { recordAdminAudit } from "../common/audit/admin-audit.js";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, count, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { users } from "@trading-dashboard/shared/database";
import {
  adminUsersQuerySchema,
  patchAdminUserRequestSchema,
  type AdminUser,
  type AdminUsersResponse,
} from "@trading-dashboard/shared/contracts";

import { AuthService } from "../common/auth/auth.service.js";
import { userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { DRIZZLE_CLIENT } from "../db/db.constants.js";
import type { DrizzleDb } from "../db/drizzle.provider.js";
import { parseOr400 } from "../common/http/validation.js";

type Tx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

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

/** GET /admin/users, PATCH /admin/users/:id. */
@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleDb,
    private readonly auth: AuthService,
  ) {}

  async list(rawQuery: unknown): Promise<AdminUsersResponse> {
    const query = parseOr400(adminUsersQuerySchema, rawQuery);
    const conditions: SQL[] = [];
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

  /**
   * Role change and/or disable. Rules, in order:
   * 404 unknown id; 400 `{code:"self"}` when an admin demotes or disables
   * themself; 409 `{code:"last_admin"}` when no enabled admin would be left.
   *
   * Runs in a transaction that first locks every enabled admin row (in id
   * order, so two admins demoting each other can't deadlock), so concurrent
   * demotions can't both pass the last-admin check.
   */
  async patch(id: number, body: unknown, actor: RequestUser | null): Promise<AdminUser> {
    const request = parseOr400(patchAdminUserRequestSchema, body);

    const updated = await this.db.transaction(async (tx) => {
      const enabledAdmins = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, "admin"), isNull(users.disabledAt)))
        .orderBy(asc(users.id))
        .for("update");

      const [target] = await tx.select().from(users).where(eq(users.id, id)).for("update");
      if (!target) throw new NotFoundException({ statusCode: 404, message: `No user ${id}` });

      if (userIdOf(actor) === id && (request.role === "user" || request.disabled === true)) {
        throw new BadRequestException({
          statusCode: 400,
          code: "self",
          message: "Admins can't demote or disable themselves",
        });
      }

      const wasEnabledAdmin = target.role === "admin" && target.disabledAt === null;
      const willBeEnabledAdmin =
        (request.role ?? target.role) === "admin" && !(request.disabled ?? target.disabledAt !== null);
      if (wasEnabledAdmin && !willBeEnabledAdmin && !enabledAdmins.some((a) => a.id !== id)) {
        throw new ConflictException({
          statusCode: 409,
          code: "last_admin",
          message: "At least one enabled admin must remain",
        });
      }

      const set: Partial<typeof users.$inferInsert> = {};
      if (request.role !== undefined) set.role = request.role;
      if (request.disabled === true) set.disabledAt = sql`now()` as unknown as Date;
      if (request.disabled === false) set.disabledAt = null;
      if (Object.keys(set).length > 0) await tx.update(users).set(set).where(eq(users.id, id));

      const updated = await this.findOne(tx, id);
      if (Object.keys(set).length > 0) await recordAdminAudit(tx, actor, "user.update", String(id),
        { role: target.role, disabled: target.disabledAt !== null }, { role: updated.role, disabled: updated.disabled });
      return updated;
    });
    // Eagerly drop local verification entries; every request also rechecks
    // persisted authorization, including requests in other processes.
    if (request.role !== undefined || request.disabled !== undefined) this.auth.invalidateUser(id);
    return updated;
  }

  private async findOne(tx: Tx, id: number): Promise<AdminUser> {
    const [row] = await tx.select(adminUserColumns).from(users).where(eq(users.id, id));
    return toAdminUser(row);
  }
}
