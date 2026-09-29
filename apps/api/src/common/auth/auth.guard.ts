import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@trading-dashboard/shared/contracts";
import type { Request } from "express";

import { AuthService, type AuthOutcome } from "./auth.service.js";
import { ROLES_KEY, type RequestUser } from "./current-user.js";
import { PERMISSIONS_KEY } from "./permissions.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";

function bearerToken(request: Request): string | undefined {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

/**
 * Global guard (applied in AppModule). Sets `request.user` (see
 * `RequestUser`) and enforces:
 * - `@Public()`: anyone. No token, or one that doesn't give a caller
 *   (invalid, expired, disabled user, sign-ups closed) → anonymous — a
 *   stale token must not block browsing; a valid one → caller attached.
 * - everything else: 401 without a caller, except a new Privy user while
 *   sign-ups are closed: 403 `{ code: "signups_closed" }`.
 * - `@Roles(...)`: human-role restriction; service principals cannot satisfy it.
 * - Permission metadata also overrides @Public; PermissionGuard runs next.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) ?? false;
    const roles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, targets);
    const needsRole = roles !== undefined && roles.length > 0;
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets);
    const open = isPublic && !needsRole && !required?.length;

    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = bearerToken(request);

    let outcome: AuthOutcome = { status: "invalid" };
    if (token) {
      try {
        outcome = await this.auth.authenticate(token);
      } catch (error) {
        // Only infrastructure failures get here (e.g. the database is down
        // while signing a user in). Public data stays reachable.
        if (!open) throw error;
        this.logger.warn(`Treating caller as anonymous on a public route: ${(error as Error).message}`);
      }
    }
    const user = outcome.status === "user" ? outcome.user : null;
    if (user) request.user = user;

    if (open) return true;
    if (outcome.status === "signups_closed") {
      throw new ForbiddenException({ statusCode: 403, code: "signups_closed", message: "Sign-ups are closed" });
    }
    if (!user) throw new UnauthorizedException("Sign in required");
    if (needsRole && (user.kind !== "user" || !roles.includes(user.role))) {
      throw new ForbiddenException(`Requires role: ${roles.join(" or ")}`);
    }
    return true;
  }
}
