import {
  ForbiddenException,
  UnauthorizedException,
  createParamDecorator,
  SetMetadata,
  type ExecutionContext,
} from "@nestjs/common";
import type { Permission, UserRole } from "@trading-dashboard/shared/contracts";

/**
 * Who is calling. The global guard sets `request.user`:
 * - a signed-in person (Privy access token) → `{ kind: "user", … }`
 * - another server holding AUTH_SERVICE_TOKEN → a scoped service principal
 * - nobody, on a @Public() route            → undefined
 */
export type RequestUser =
  | { kind: "user"; id: number; privyUserId: string; role: UserRole }
  | { kind: "service"; permissions: readonly Permission[] };

/** The caller, or null when a public route is called anonymously. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | null =>
    context.switchToHttp().getRequest<{ user?: RequestUser }>().user ?? null,
);

export const ROLES_KEY = "roles";

/** Restricts a route to human users with one of these roles.
 * Service access must use explicit permission metadata instead. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in user's id, or null for anonymous and service callers. */
export function userIdOf(user: RequestUser | null): number | null {
  return user?.kind === "user" ? user.id : null;
}

/** Only a signed-in human has owned resources; service principals do not. */
export function requireUserId(user: RequestUser | null): number {
  if (!user) throw new UnauthorizedException("Sign in required");
  if (user.kind !== "user") throw new ForbiddenException("Only a signed-in user has a profile");
  return user.id;
}
