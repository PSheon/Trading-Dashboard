import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { AuthService, type AuthOutcome } from "./auth.service.js";
import type { RequestUser } from "./current-user.js";
import { requiredPermissions } from "./permissions.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import { preferredLocale } from "./request-locale.js";
import { safeErrorText } from "../../runtime/safe-error-text.js";

function bearerToken(request: Request): string | undefined {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token || undefined;
}

/**
 * Global guard: sets `request.user` and enforces
 * - `@Public()`: anyone; a token that gives no caller → anonymous (a stale token must not block browsing);
 * - everything else: 401 without a caller (403 `signups_closed` for a new user while closed).
 * Permission metadata (`@RequirePermissions`) overrides @Public; PermissionGuard runs next.
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
    const required = requiredPermissions(this.reflector, targets);
    const open = isPublic && !required?.length;

    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = bearerToken(request);

    let outcome: AuthOutcome = { status: "invalid" };
    if (token) {
      try {
        outcome = await this.auth.authenticate(token, { locale: preferredLocale(request.headers["accept-language"]) });
      } catch (error) {
        // Infrastructure failure only (e.g. DB down): public data stays reachable.
        if (!open) throw error;
        this.logger.warn(`Treating caller as anonymous on a public route: ${safeErrorText(error)}`);
      }
    }
    const user = outcome.status === "user" ? outcome.user : null;
    if (user) request.user = user;

    if (open) return true;
    if (outcome.status === "signups_closed") {
      throw new ForbiddenException({ statusCode: 403, code: "signups_closed", message: "Sign-ups are closed" });
    }
    if (!user) throw new UnauthorizedException("Sign in required");
    return true;
  }
}
