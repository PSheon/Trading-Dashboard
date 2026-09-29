import { createParamDecorator, SetMetadata, type ExecutionContext } from "@nestjs/common";
import type { UserRole } from "@trading-dashboard/shared";

/**
 * Who is calling. The global guard sets `request.user`:
 * - a signed-in person (Privy access token) → `{ kind: "user", … }`
 * - another server holding AUTH_SERVICE_TOKEN   → `{ kind: "service" }`
 * - nobody, on a @Public() route            → undefined
 */
export type RequestUser =
  | { kind: "user"; id: number; privyUserId: string; role: UserRole }
  | { kind: "service" };

/** The caller, or null when a public route is called anonymously. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser | null =>
    context.switchToHttp().getRequest<{ user?: RequestUser }>().user ?? null,
);

export const ROLES_KEY = "roles";

/** Restricts a route to signed-in users with one of these roles. The
 * service token counts as admin. */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** The signed-in user's id, or null for anonymous and service callers. */
export function userIdOf(user: RequestUser | null): number | null {
  return user?.kind === "user" ? user.id : null;
}
