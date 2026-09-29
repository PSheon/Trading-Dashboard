import { BadRequestException, ForbiddenException, UnauthorizedException } from "@nestjs/common";

import type { RequestUser } from "../common/auth/current-user.js";

interface SafeParser<T> {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** Validates a body/param against a shared zod contract; 400 with the
 * issues on failure. */
export function parseOr400<T>(schema: SafeParser<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: "Invalid request",
      issues: result.error.issues.map((i) => ({ path: i.path.map(String).join("."), message: i.message })),
    });
  }
  return result.data;
}

/** The signed-in user's id. /me routes belong to a person: the service
 * token (no user row) gets 403, nobody gets 401. */
export function requireUserId(user: RequestUser | null): number {
  if (!user) throw new UnauthorizedException("Sign in required");
  if (user.kind !== "user") throw new ForbiddenException("Only a signed-in user has a profile");
  return user.id;
}
