import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  adminUsersQuerySchema,
  patchAdminUserRequestSchema,
  type AdminUser,
  type AdminUsersResponse,
} from "@trading-dashboard/shared/contracts";

import { AuthService } from "../common/auth/auth.service.js";
import { userIdOf, type RequestUser } from "../common/auth/current-user.js";
import { AdminUsersRepository } from "./admin-users.repository.js";
import { UnitOfWork } from "../db/unit-of-work.js";
import { parseOr400 } from "../common/http/validation.js";

/** GET /admin/users, PATCH /admin/users/:id. */
@Injectable()
export class AdminUsersService {
  constructor(
    private readonly repository: AdminUsersRepository,
    private readonly unitOfWork: UnitOfWork,
    private readonly auth: AuthService,
  ) {}

  async list(rawQuery: unknown): Promise<AdminUsersResponse> {
    const query = parseOr400(adminUsersQuerySchema, rawQuery);
    return this.repository.list(query);
  }

  /**
   * Role change (user, operator, admin) and/or disable. Rules, in order:
   * 404 unknown id; 400 `{code:"self"}` when an admin demotes (to operator
   * or user) or disables themself; 409 `{code:"last_admin"}` when no
   * enabled admin would be left.
   *
   * Runs in a transaction that first locks every enabled admin row (in id
   * order, so two admins demoting each other can't deadlock), so concurrent
   * demotions can't both pass the last-admin check.
   */
  async patch(id: number, body: unknown, actor: RequestUser | null): Promise<AdminUser> {
    const request = parseOr400(patchAdminUserRequestSchema, body);

    const updated = await this.unitOfWork.run(async (tx) => {
      const enabledAdmins = await this.repository.lockEnabledAdmins(tx);
      const target = await this.repository.lockUser(tx, id);
      if (!target) throw new NotFoundException({ statusCode: 404, message: `No user ${id}` });

      if (userIdOf(actor) === id && ((request.role !== undefined && request.role !== "admin") || request.disabled === true)) {
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

      const updated = await this.repository.patch(tx, id, request);
      if (request.role !== undefined || request.disabled !== undefined) {
        await this.repository.recordUpdate(tx, actor, id,
          { role: target.role, disabled: target.disabledAt !== null },
          { role: updated.role, disabled: updated.disabled });
      }
      return updated;
    });
    // Eagerly drop local verification entries; every request also rechecks
    // persisted authorization, including requests in other processes.
    if (request.role !== undefined || request.disabled !== undefined) this.auth.invalidateUser(id);
    return updated;
  }

}
