import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@trading-dashboard/shared";
import type { Request } from "express";

import { AuthService } from "./auth.service.js";
import { ROLES_KEY, type RequestUser } from "./current-user.js";
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
 * - `@Public()`: anyone. No token, or one that doesn't verify → anonymous
 *   (a stale token must not block browsing); a valid one → caller attached.
 * - everything else: 401 without a valid caller (service token or Privy).
 * - `@Roles(...)`: additionally 403 unless the user's role is listed; the
 *   service token counts as admin. `@Roles` wins over `@Public`.
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

    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = bearerToken(request);

    let user: RequestUser | null = null;
    if (token) {
      try {
        user = await this.auth.resolve(token);
      } catch (error) {
        // Only infrastructure failures get here (e.g. the database is down
        // while signing a user in). Public data stays reachable.
        if (!isPublic || needsRole) throw error;
        this.logger.warn(`Treating caller as anonymous on a public route: ${(error as Error).message}`);
      }
    }
    if (user) request.user = user;

    if (isPublic && !needsRole) return true;
    if (!user) throw new UnauthorizedException("Sign in required");
    if (needsRole && user.kind === "user" && !roles.includes(user.role)) {
      throw new ForbiddenException(`Requires role: ${roles.join(" or ")}`);
    }
    return true;
  }
}
