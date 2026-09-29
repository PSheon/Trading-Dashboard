import { ForbiddenException, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Permission } from "@trading-dashboard/shared";
import type { RequestUser } from "./current-user.js";
import { hasPermission, PERMISSIONS_KEY } from "./permissions.js";

/** Runs after AuthGuard; resource ownership remains the feature's responsibility. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<{ user?: RequestUser }>().user;
    if (!user) throw new UnauthorizedException("Sign in required");
    if (!required.every((permission) => hasPermission(user, permission))) {
      throw new ForbiddenException({ statusCode: 403, code: "insufficient_permissions", message: "Insufficient permissions" });
    }
    return true;
  }
}
